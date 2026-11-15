"""Kill an actual packaged Host during an uncommitted migration, then reopen it."""
from contextlib import closing
import json
import os
from pathlib import Path
import signal
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
import hashlib

from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location("upgrade_checks", Path(__file__).with_name("check-courseware-upgrade.py"))
upgrade = module_from_spec(spec)
spec.loader.exec_module(upgrade)


def retained(directory):
    with closing(sqlite3.connect(f"file:{directory / 'pi.sqlite'}?mode=ro", uri=True)) as db:
        result = {"schema": db.execute("PRAGMA user_version").fetchone()[0], "tables": {}}
        for table, columns, order in [
            ("sessions", "id,title,project_id,mode,thinking_level,permission_mode,last_seq,created_at,updated_at", "id"),
            ("messages", "id,session_id,seq,role,text,created_at", "id"),
            ("kv", "ns,key,value_json", "ns,key"),
        ]:
            digest = hashlib.sha256()
            count = 0
            for row in db.execute(f"SELECT {columns} FROM {table} ORDER BY {order}"):
                digest.update((json.dumps(row, ensure_ascii=False) + "\n").encode())
                count += 1
            result["tables"][table] = {"rows": count, "sha256": digest.hexdigest()}
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert not db.execute("SELECT 1 FROM sqlite_master WHERE name='sessions_v19'").fetchall()
        return result


def uncommitted_wal(path):
    with path.open("rb") as wal:
        header = wal.read(32)
        assert len(header) == 32
        magic, _, page_size, _, salt1, salt2, _, _ = struct.unpack(">8I", header)
        assert magic in (0x377F0682, 0x377F0683)
        frame_size = page_size + 24
        frames = (path.stat().st_size - 32) // frame_size
        assert frames > 0
        for index in range(frames):
            wal.seek(32 + index * frame_size)
            page, committed_pages, frame_salt1, frame_salt2, _, _ = struct.unpack(">6I", wal.read(24))
            assert page > 0 and committed_pages == 0, "Kill point was not inside the uncommitted transaction"
            assert (frame_salt1, frame_salt2) == (salt1, salt2)
        return {"bytes": path.stat().st_size, "pageSize": page_size,
                "uncommittedFrames": frames, "commitMarkers": 0}


def main():
    assert sys.platform == "linux", "This interruption harness uses Linux SIGSTOP/SIGKILL"
    assert len(sys.argv) == 4, "Supply current Host, schema18 Host and NEW evidence directory"
    current, older, output = [Path(value).resolve() for value in sys.argv[1:]]
    assert current.is_file() and older.is_file() and current != older
    output.mkdir(parents=True, exist_ok=False)
    report = {"status": "RUNNING", "paidCalls": False, "userData": False, "checks": [],
              "currentHost": {"path": str(current), "sha256": upgrade.digest(current)},
              "olderHost": {"path": str(older), "sha256": upgrade.digest(older)}}
    try:
        with tempfile.TemporaryDirectory(prefix="deckwise-migration-kill-") as temporary:
            data = Path(temporary) / "data"
            upgrade.seed(older, data, output, "old-initialize")
            # Exceed the real Host's 16-MiB cache so migration writes reach WAL before commit.
            with closing(sqlite3.connect(data / "pi.sqlite")) as db:
                db.executemany("INSERT INTO sessions (id,title,project_id,created_at,updated_at) VALUES (?,?,1,1,2)",
                               ((f"bulk-{i:06d}", f"Migration fixture {i}: " + "x" * 1024) for i in range(24000)))
                db.commit()
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            before = retained(data)
            asset = data / "retained-lesson-asset.bin"
            asset.write_bytes(b"Retained local lesson asset; no supplier calls")
            asset_hash = upgrade.digest(asset)
            env = {key: value for key, value in os.environ.items()
                   if not any(word in key.lower() for word in ["key", "secret", "token", "password", "proxy"])
                   and not key.startswith(("PI_DESKTOP_", "DECKWISE_"))}
            env.update(PI_DESKTOP_DATA_DIR=str(data), PI_DESKTOP_PLUGIN_MARKET_URL="http://127.0.0.1:9/catalog.json")
            with (output / "interrupted.stdout.txt").open("w") as stdout, (output / "interrupted.stderr.txt").open("w") as stderr:
                process = subprocess.Popen([str(current)], stdin=subprocess.PIPE, stdout=stdout, stderr=stderr, env=env)
                try:
                    backup = data / "pi.sqlite.v18.bak"
                    wal = data / "pi.sqlite-wal"
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        assert process.poll() is None, "Host exited before the migration kill point"
                        if backup.exists() and wal.exists() and wal.stat().st_size > 65536:
                            os.kill(process.pid, signal.SIGSTOP)
                            _, stopped = os.waitpid(process.pid, os.WUNTRACED)
                            assert os.WIFSTOPPED(stopped)
                            break
                        time.sleep(0.001)
                    else:
                        raise AssertionError("Did not observe migration WAL writes before the deadline")
                    report["killPoint"] = uncommitted_wal(wal)
                    assert retained(data) == before
                    with closing(sqlite3.connect(f"file:{backup}?mode=ro", uri=True)) as db:
                        assert db.execute("PRAGMA user_version").fetchone()[0] == 18
                        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                        assert db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 24001
                    process.kill()
                    assert process.wait(timeout=10) == -signal.SIGKILL
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=10)
                    process.stdin.close()
            report["checks"].append("Packaged Host is SIGKILLed after real migration WAL writes, with zero commit markers and schema18 still visible")
            assert retained(data) == before
            assert upgrade.digest(asset) == asset_hash
            report["checks"].append("Reopening after SIGKILL preserves all 24001 sessions, message/KV fingerprints and referenced asset")
            upgrade.launch(current, data, output, "restart-upgrade")
            assert retained(data) == {**before, "schema": 24}
            assert upgrade.digest(asset) == asset_hash
            for version in range(18, 24):
                with closing(sqlite3.connect(f"file:{data / f'pi.sqlite.v{version}.bak'}?mode=ro", uri=True)) as db:
                    assert db.execute("PRAGMA user_version").fetchone()[0] == version
                    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            upgrade.launch(current, data, output, "second-restart")
            assert retained(data) == {**before, "schema": 24}
            assert upgrade.digest(asset) == asset_hash
            report["checks"].append("The same packaged Host completes upgrade to24, retains six valid backups, and preserves data through a second restart")
            report["before"] = before
            report["assetSha256"] = asset_hash
            report["status"] = "PASS_PACKAGED_MIGRATION_SIGKILL_RECOVERY"
    except Exception as error:
        report["status"] = "FAIL"
        report["error"] = repr(error)
        raise
    finally:
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(report["status"], len(report["checks"]), "checks")


if __name__ == "__main__":
    main()
