"""MySQL 保存账号、会话、候选及幂等状态；长期记忆在 MemoryOS。"""
import hashlib
from datetime import datetime, timezone
import json
from pathlib import Path
import uuid

from .errors import ServiceError
from .database import MySQLDatabase, SQLiteConfig, SQLiteDatabase


def now():
    return datetime.now(timezone.utc).isoformat()


def page_data(items, total, page, limit):
    return {"items": items, "total": total, "page": page, "total_pages": (total + limit - 1) // limit}


class Store(MySQLDatabase):
    def __init__(self, config):
        # 配置为 SQLiteConfig 时改用 SQLite（仅本机测试）；其余行为沿用 MySQL。
        self.sqlite = isinstance(config, SQLiteConfig)
        if self.sqlite:
            SQLiteDatabase.__init__(self, config)
        else:
            super().__init__(config)

    def db(self):
        return SQLiteDatabase.db(self) if self.sqlite else super().db()

    def initialize(self):
        # 仅在启动阶段建表，导入模块不访问数据库。
        sql_dir = Path(__file__).resolve().parents[1] / 'sql'
        schema = sql_dir / 'sqlite' / '005_sqlite_store.sql' if self.sqlite else sql_dir / 'mysql' / '005_mysql_store.sql'
        with self.db() as db:
            for statement in schema.read_text().split(';'):
                if statement.strip():
                    db.execute(statement)
            # 进程重启后的请求允许用原 source_id 重试，不能把中断当作成功。
            db.execute("UPDATE operations SET state='failed' WHERE state='running'")

    def session(self, session_id, scope):
        with self.db() as db:
            row = db.execute("SELECT * FROM sessions WHERE id=%s AND scope=%s", (session_id, scope)).fetchone()
        if row is None:
            raise ServiceError("会话不存在或不属于当前连接", 404)
        return {k: row[k] for k in ("id", "mode", "title", "created_at", "surface")}

    def create_session(self, scope, mode, title, surface="pet"):
        result = {"id": str(uuid.uuid4()), "mode": mode, "title": title, "created_at": now(), "surface": surface}
        with self.db() as db:
            db.execute("INSERT INTO sessions (id,scope,mode,title,created_at,surface) VALUES(%s,%s,%s,%s,%s,%s)", (result["id"], scope, mode, title, result["created_at"], surface))
        return result

    def sessions(self, scope, page, limit, mode, surface="pet"):
        where, params = "scope=%s AND surface=%s", [scope, surface]
        if mode:
            where += " AND mode=%s"
            params.append(mode)
        with self.db() as db:
            total = db.execute(f"SELECT count(*) AS total FROM sessions WHERE {where}", params).fetchone()["total"]
            rows = db.execute(f"SELECT id,mode,title,created_at,surface FROM sessions WHERE {where} ORDER BY created_at DESC LIMIT %s OFFSET %s", [*params, limit, (page - 1) * limit]).fetchall()
        return page_data([dict(r) for r in rows], total, page, limit)

    def mode(self, session_id, scope, mode):
        self.session(session_id, scope)
        with self.db() as db:
            db.execute("UPDATE sessions SET mode=%s WHERE id=%s", (mode, session_id))
        return self.session(session_id, scope)

    def messages(self, session_id, scope, page=1, limit=100):
        self.session(session_id, scope)
        with self.db() as db:
            total = db.execute("SELECT count(*) AS total FROM messages WHERE session_id=%s", (session_id,)).fetchone()["total"]
            rows = db.execute("SELECT body FROM messages WHERE session_id=%s ORDER BY created_at LIMIT %s OFFSET %s", (session_id, limit, (page - 1) * limit)).fetchall()
            candidates = db.execute("SELECT id,content,status,memory_ids FROM candidates WHERE session_id=%s", (session_id,)).fetchall()
        by_id = {c["id"]: {**dict(c), "memory_ids": json.loads(c["memory_ids"])} for c in candidates}
        items = [json.loads(r["body"]) for r in rows]
        for item in items:
            item["candidates"] = [by_id.get(c["id"], c) for c in item.get("candidates", [])]
        return page_data(items, total, page, limit)

    def history(self, session_id, scope):
        self.session(session_id, scope)
        with self.db() as db:
            rows = db.execute("SELECT body FROM messages WHERE session_id=%s ORDER BY created_at DESC LIMIT 20", (session_id,)).fetchall()
        return [{"role": b["role"], "content": b["content"]} for b in (json.loads(r["body"]) for r in reversed(rows))]

    def candidates_by_ids(self, session_id, scope, candidate_ids):
        self.session(session_id, scope)
        if not candidate_ids:
            return {}
        placeholders = ",".join("%s" for _ in candidate_ids)
        with self.db() as db:
            rows = db.execute(f"SELECT * FROM candidates WHERE session_id=%s AND id IN ({placeholders})", [session_id, *candidate_ids]).fetchall()
        return {r["id"]: {**dict(r), "memory_ids": json.loads(r["memory_ids"])} for r in rows}

    def begin_operation(self, key, session_id, fingerprint, legacy_fingerprint=None):
        with self.db() as db:
            # 先用唯一键取得请求行锁，跨连接重试不能同时发起模型或记忆写入。
            db.execute("INSERT INTO operations (id,session_id,fingerprint,state,result) VALUES(%s,%s,%s,'pending',NULL) ON DUPLICATE KEY UPDATE id=id", (key, session_id, fingerprint))
            row = db.execute("SELECT * FROM operations WHERE id=%s FOR UPDATE", (key,)).fetchone()
            if row["session_id"] != session_id or (row["fingerprint"] != fingerprint and row["fingerprint"] != legacy_fingerprint and row["state"] != "editable"):
                raise ServiceError("同一请求编号不能用于不同消息或模式", 409)
            if row["state"] == "completed":
                return json.loads(row["result"])
            if row["state"] == "running":
                raise ServiceError("该请求正在处理中，请稍候", 409)
            db.execute("UPDATE operations SET state='running',fingerprint=%s WHERE id=%s", (fingerprint, key))
        return None

    def fail_operation(self, key, state="failed"):
        with self.db() as db:
            db.execute("UPDATE operations SET state=%s WHERE id=%s AND state='running'", (state, key))

    def complete_chat(self, key, session_id, result):
        messages = [result["user_message"], result["assistant_message"]]
        with self.db() as db:
            db.executemany("INSERT INTO messages (id,session_id,body,created_at) VALUES(%s,%s,%s,%s)", [(m["id"], session_id, json.dumps(m, ensure_ascii=False), m["created_at"]) for m in messages])
            db.executemany("INSERT INTO candidates (id,session_id,content,status,memory_ids,source_id) VALUES(%s,%s,%s,'pending','[]',%s)", [(c["id"], session_id, c["content"], f"memory-pet:{c['id']}:{hashlib.sha256(c['content'].encode()).hexdigest()[:16]}") for c in result["assistant_message"]["candidates"]])
            db.execute("UPDATE operations SET state='completed',result=%s WHERE id=%s", (json.dumps(result, ensure_ascii=False), key))

    def candidate(self, session_id, scope, candidate_id):
        self.session(session_id, scope)
        with self.db() as db:
            row = db.execute("SELECT * FROM candidates WHERE id=%s AND session_id=%s", (candidate_id, session_id)).fetchone()
        if row is None:
            raise ServiceError("训练候选不存在", 404)
        return {**dict(row), "memory_ids": json.loads(row["memory_ids"])}

    def update_candidate(self, candidate_id, *, content=None, status=None, memory_ids=None):
        with self.db() as db:
            row = db.execute("SELECT * FROM candidates WHERE id=%s FOR UPDATE", (candidate_id,)).fetchone()
            next_content = content if content is not None else row["content"]
            source_id = f"memory-pet:{candidate_id}:{hashlib.sha256(next_content.encode()).hexdigest()[:16]}"
            db.execute("UPDATE candidates SET content=%s,status=%s,memory_ids=%s,source_id=%s WHERE id=%s", (next_content, status or row["status"], json.dumps(memory_ids) if memory_ids is not None else row["memory_ids"], source_id, candidate_id))

    def confirmation_state(self, candidate_id):
        with self.db() as db:
            row = db.execute("SELECT state FROM operations WHERE id=%s", (f"confirm:{candidate_id}",)).fetchone()
        return row["state"] if row else None

    def complete_confirmation(self, candidate_id, memory_ids, result):
        with self.db() as db:
            db.execute("UPDATE candidates SET status='confirmed',memory_ids=%s WHERE id=%s", (json.dumps(memory_ids), candidate_id))
            db.execute("UPDATE operations SET state='completed',result=%s WHERE id=%s", (json.dumps(result, ensure_ascii=False), f"confirm:{candidate_id}"))
