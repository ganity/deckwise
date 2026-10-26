"""Exercise packaged Host migration/refusal/recovery on disposable local data."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_state(directory):
    with sqlite3.connect(f"file:{directory / 'pi.sqlite'}?mode=ro", uri=True) as db:
        return {
            "schema": db.execute("PRAGMA user_version").fetchone()[0],
            "sessions": db.execute("SELECT id,title FROM sessions ORDER BY id").fetchall(),
            "messages": db.execute("SELECT id,text FROM messages ORDER BY id").fetchall(),
            "sentinel": db.execute("SELECT value_json FROM kv WHERE ns='upgrade-fixture'").fetchone()[0],
            "integrity": db.execute("PRAGMA integrity_check").fetchone()[0],
            "foreignKeys": db.execute("PRAGMA foreign_key_check").fetchall(),
        }


def launch(binary, directory, output, label, succeeds=True, error=None):
    env = {key: value for key, value in os.environ.items()
           if not any(word in key.lower() for word in ["key", "secret", "token", "password", "proxy"])
           and not key.startswith(("PI_DESKTOP_", "DECKWISE_"))}
    env.update(PI_DESKTOP_DATA_DIR=str(directory), PI_DESKTOP_PLUGIN_MARKET_URL="http://127.0.0.1:9/catalog.json")
    result = subprocess.run([str(binary)], input=json.dumps({"jsonrpc": "2.0", "id": "upgrade-probe",
                            "method": "app.handshake", "params": {"protocolVersion": 11}}) + "\n",
                            text=True, capture_output=True, env=env, timeout=30)
    (output / f"{label}.stderr.txt").write_text(result.stderr)
    assert (result.returncode == 0) == succeeds, (label, result.returncode, result.stderr[-1500:])
    if succeeds:
        replies = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
        assert any(item.get("id") == "upgrade-probe" and item.get("result", {}).get("protocolVersion") == 11
                   for item in replies), (label, result.stdout[-1500:])
    if error:
        assert error in result.stderr, (label, result.stderr[-1500:])


def seed(binary, directory, output, label):
    directory.mkdir()
    launch(binary, directory, output, label)
    with sqlite3.connect(directory / "pi.sqlite") as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 18
        db.execute("INSERT INTO projects (id,path,name,created_at,last_opened_at) VALUES (1,?,'Lesson',1,2)",
                   (str(directory / "workspace"),))
        db.execute("INSERT INTO sessions (id,title,project_id,created_at,updated_at) VALUES ('kept','Keep my lesson',1,1,2)")
        db.execute("INSERT INTO messages (id,session_id,seq,role,text,created_at) VALUES ('kept-message','kept',1,'user','Keep the lesson brief',1)")
        db.execute("INSERT INTO kv (ns,key,value_json,updated_at) VALUES ('upgrade-fixture','kept',?,1)",
                   (json.dumps({"narration": "Good!", "unknownTask": "hold-do-not-resubmit"}),))
    state = read_state(directory)
    assert state["integrity"] == "ok" and not state["foreignKeys"]
    return state


def preserved(before, after, schema):
    assert after == {**before, "schema": schema}, (before, after)


def main():
    assert len(sys.argv) == 4, "Supply current packaged Host, older schema18 Host and NEW evidence directory"
    current, older, output = [Path(value).resolve() for value in sys.argv[1:]]
    assert current.is_file() and older.is_file() and current != older
    output.mkdir(parents=True, exist_ok=False)
    report = {"status": "RUNNING", "checks": [], "paidCalls": False, "electronUi": False,
              "currentHost": {"path": str(current), "sha256": digest(current)},
              "olderHost": {"path": str(older), "sha256": digest(older)}}
    try:
        with tempfile.TemporaryDirectory(prefix="deckwise-upgrade-") as temporary:
            root = Path(temporary)
            data = root / "upgrade"
            before = seed(older, data, output, "old-initialize")
            workspace = data / "workspace"
            workspace.mkdir()
            asset = workspace / "retained-asset.bin"
            asset.write_bytes(b"retained local asset; no supplier request")
            asset_hash = digest(asset)
            launch(current, data, output, "new-upgrade")
            preserved(before, read_state(data), 24)
            for version in range(18, 24):
                backup = data / f"pi.sqlite.v{version}.bak"
                with sqlite3.connect(f"file:{backup}?mode=ro", uri=True) as db:
                    assert db.execute("PRAGMA user_version").fetchone()[0] == version
                    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            report["checks"].append("Actual schema18 Host data upgrades to 24 with retained rows and six readable backups")

            launch(current, data, output, "new-reopen")
            preserved(before, read_state(data), 24)
            database_hash = digest(data / "pi.sqlite")
            launch(older, data, output, "old-refuses-new", succeeds=False,
                   error="database schema version 24 is newer than supported 18")
            assert digest(data / "pi.sqlite") == database_hash
            preserved(before, read_state(data), 24)
            assert digest(asset) == asset_hash
            report["checks"].append("Older packaged Host refuses schema24 without changing the database or retained asset")

            failed = root / "failed-migration"
            failed_before = seed(older, failed, output, "failure-old-initialize")
            with sqlite3.connect(failed / "pi.sqlite") as db:
                db.execute("CREATE TABLE sessions_v19 (collision TEXT)")
            launch(current, failed, output, "migration-fails", succeeds=False, error="sessions_v19")
            preserved(failed_before, read_state(failed), 18)
            shutil.copy2(failed / "pi.sqlite.v18.bak", output / "failed-migration-v18-backup.sqlite")
            with sqlite3.connect(failed / "pi.sqlite.v18.bak") as db:
                assert db.execute("PRAGMA user_version").fetchone()[0] == 18
                assert db.execute("SELECT title FROM sessions WHERE id='kept'").fetchone()[0] == "Keep my lesson"
            with sqlite3.connect(failed / "pi.sqlite") as db:
                db.execute("DROP TABLE sessions_v19")
            launch(current, failed, output, "migration-explicit-retry")
            preserved(failed_before, read_state(failed), 24)
            report["checks"].append("Injected migration failure rolls back to 18 and retains backup; explicit correction permits upgrade")

            restored = root / "restored-backup"
            restored.mkdir()
            shutil.copy2(data / "pi.sqlite.v18.bak", restored / "pi.sqlite")
            launch(older, restored, output, "old-opens-separate-backup")
            preserved(before, read_state(restored), 18)
            preserved(before, read_state(data), 24)
            assert digest(asset) == asset_hash
            report["checks"].append("Old Host opens a separate pre-upgrade backup while upgraded data and assets remain intact")

            future = root / "future"
            future.mkdir()
            shutil.copy2(data / "pi.sqlite", future / "pi.sqlite")
            with sqlite3.connect(future / "pi.sqlite") as db:
                db.execute("PRAGMA user_version=25")
            future_hash = digest(future / "pi.sqlite")
            launch(current, future, output, "current-refuses-future", succeeds=False,
                   error="database schema version 25 is newer than supported 24")
            assert digest(future / "pi.sqlite") == future_hash
            preserved(before, read_state(future), 25)
            report["checks"].append("Current packaged Host also refuses unknown schema25 without rewriting it")
            report["retainedState"] = before
            report["assetSha256"] = asset_hash
            report["status"] = "PASS_PACKAGED_HOST_UPGRADE_RECOVERY"
    except Exception as error:
        report["status"] = "FAIL"
        report["error"] = repr(error)
        raise
    finally:
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(report["status"], len(report["checks"]), "checks")


if __name__ == "__main__":
    main()
