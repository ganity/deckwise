use super::*;

fn seed(path: &Path, version: i64) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(if version == 18 {
        include_str!("fixtures/schema-v18.sql")
    } else {
        include_str!("fixtures/schema-v24.sql")
    })
    .unwrap();
    conn.execute_batch(PLAN_APPROVALS_SCHEMA).unwrap();
    conn.execute_batch(crate::session_collaboration::SCHEMA)
        .unwrap();
    conn.pragma_update(None, "user_version", version).unwrap();
    conn.execute_batch(
        r#"INSERT INTO projects (id, path, name, created_at, last_opened_at)
             VALUES (1, '/work/lesson', 'Lesson', 1, 2);
         INSERT INTO sessions (id, title, project_id, created_at, updated_at)
             VALUES ('kept', 'My lesson', 1, 1, 2);
         INSERT INTO messages (id, session_id, seq, role, text, created_at)
             VALUES ('message', 'kept', 1, 'user', 'Keep my lesson', 1);
         INSERT INTO kv (ns, key, value_json, updated_at)
             VALUES ('compat', 'kept', '{"keep":true}', 1);"#,
    )
    .unwrap();
}

fn assert_kept(db: &Database) {
    assert_eq!(
        db.conn()
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        24
    );
    assert_eq!(
        crate::sessions::get_session(db, "kept")
            .unwrap()
            .unwrap()
            .summary
            .title,
        "My lesson"
    );
    assert_eq!(
        db.kv_get("compat", "kept").unwrap(),
        Some(serde_json::json!({"keep": true}))
    );
    assert_eq!(
        db.conn()
            .query_row("SELECT text FROM messages WHERE id = 'message'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        "Keep my lesson"
    );
    assert_eq!(
        db.conn()
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
    assert_eq!(
        db.conn()
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}

#[test]
fn schema24_upgrades_real_v18_without_losing_session_or_courseware() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    seed(&path, 18);
    let project;
    {
        let db = Database::open(&path).unwrap();
        assert_kept(&db);
        for version in 18..24 {
            let backup = Connection::open(migration_backup_path(&path, version)).unwrap();
            assert_eq!(
                backup
                    .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                version
            );
        }
        assert_eq!(
            db.conn()
                .query_row(
                    "SELECT title_source FROM sessions WHERE id = 'kept'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "manual"
        );
        db.conn()
            .execute(
                "UPDATE sessions SET thinking_level = 'omit' WHERE id = 'kept'",
                [],
            )
            .unwrap();
        db.conn().execute("INSERT INTO session_todo VALUES ('kept', 0, 'Keep checklist', 'pending', 'medium', 1)", []).unwrap();
        project = db
            .open_saved_courseware_project(
                dir.path().to_str().unwrap(),
                "lesson",
                &"a".repeat(64),
                2,
            )
            .unwrap();
    }
    let db = Database::open(&path).unwrap();
    assert_kept(&db);
    assert_eq!(
        serde_json::to_value(
            db.get_courseware_project(dir.path().to_str().unwrap(), &project.project_id)
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(project).unwrap()
    );
}

#[test]
fn schema24_opens_independent_main_database_preserving_new_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    seed(&path, 24);
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "UPDATE sessions SET thinking_level = 'omit', title_source = 'manual', todo_revision = 7 WHERE id = 'kept';
             UPDATE projects SET worktree_setup_command = 'pnpm install' WHERE id = 1;
             INSERT INTO session_todo VALUES ('kept', 0, 'Keep checklist', 'pending', 'medium', 1);
             INSERT INTO worktrees (id, session_id, path, common_dir, branch, owner_branch, status, created_at, updated_at)
                 VALUES ('worktree', 'kept', '/work/isolated', '/work/.git', 'lesson', 'main', 'active', 1, 2);",
        ).unwrap();
    }
    for _ in 0..2 {
        let db = Database::open(&path).unwrap();
        assert_kept(&db);
        assert_eq!(db.conn().query_row("SELECT thinking_level || ':' || title_source || ':' || todo_revision FROM sessions WHERE id = 'kept'", [], |r| r.get::<_, String>(0)).unwrap(), "omit:manual:7");
        assert_eq!(
            db.conn()
                .query_row(
                    "SELECT worktree_setup_command FROM projects WHERE id = 1",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "pnpm install"
        );
        assert_eq!(
            db.conn()
                .query_row(
                    "SELECT content FROM session_todo WHERE session_id = 'kept'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "Keep checklist"
        );
        assert_eq!(
            db.conn()
                .query_row(
                    "SELECT session_id FROM worktrees WHERE id = 'worktree'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "kept"
        );
    }
    assert!(!migration_backup_path(&path, 24).exists());
}

#[test]
fn schema24_still_refuses_unknown_future_schema() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    seed(&path, 24);
    {
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 25).unwrap();
    }
    let error = Database::open(&path).err().unwrap();
    assert!(
        error.to_string().contains("newer than supported 24"),
        "{error}"
    );
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        25
    );
}

#[test]
fn schema24_upgrades_each_intermediate_version() {
    for version in 19..24 {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        seed(&path, 18);
        {
            let conn = Connection::open(&path).unwrap();
            migrate_v18_to_v19(&conn, &path).unwrap();
            if version >= 20 {
                migrate_v19_to_v20(&conn, &path).unwrap();
            }
            if version >= 21 {
                migrate_v20_to_v21(&conn, &path).unwrap();
            }
            if version >= 22 {
                super::migrations::migrate_v21_to_v22(&conn, &path).unwrap();
            }
            if version >= 23 {
                migrate_v22_to_v23(&conn, &path).unwrap();
            }
            assert_eq!(
                conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                version
            );
        }
        let db = Database::open(&path).unwrap();
        assert_kept(&db);
        assert!(migration_backup_path(&path, version).exists());
    }
}

#[test]
fn schema24_failed_rebuild_keeps_v18_and_readable_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    seed(&path, 18);
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE sessions_v19 (collision TEXT);")
            .unwrap();
    }
    assert!(Database::open(&path).is_err());
    for candidate in [path.clone(), migration_backup_path(&path, 18)] {
        let conn = Connection::open(candidate).unwrap();
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            18
        );
        assert_eq!(
            conn.query_row("SELECT title FROM sessions WHERE id = 'kept'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "My lesson"
        );
    }
}
