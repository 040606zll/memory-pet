"""MySQL 配置与连接池，所有数据库访问使用独立短事务。"""
from contextlib import contextmanager
from dataclasses import dataclass, field
import asyncio
import hashlib
import re

from sqlalchemy import create_engine, event
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from .errors import ServiceError


async def run_db(function, *args, **kwargs):
    """取消请求时先等待短事务结束，再执行调用方清理，避免工作线程迟到提交。"""
    task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await asyncio.gather(task, return_exceptions=True)
        raise


@dataclass(frozen=True)
class DatabaseConfig:
    host: str = '127.0.0.1'
    port: int = 3306
    database: str = 'memory_pet'
    user: str = 'memory_pet'
    password: str = field(default='', repr=False)

    def __post_init__(self):
        if not isinstance(self.host, str) or not self.host.strip():
            raise ServiceError('MySQL 配置 mysql.host 无效，请填写数据库主机', 500)
        if not isinstance(self.user, str) or not self.user.strip():
            raise ServiceError('MySQL 配置 mysql.user 无效，请填写数据库用户名', 500)
        # 库名作为驱动连接参数传递，不拼接 SQL；横线、中文和保留字均可原样使用。
        # MySQL 库名最多 64 个 BMP 字符，禁止 NUL、路径分隔符、点及末尾空格。
        # https://dev.mysql.com/doc/refman/8.0/en/identifiers.html
        name = self.database
        if (not isinstance(name, str) or not 1 <= len(name) <= 64
                or name.endswith(' ') or any(char in name for char in '/\\.')
                or any(not 0 < ord(char) <= 0xFFFF or 0xD800 <= ord(char) <= 0xDFFF for char in name)):
            raise ServiceError('MySQL 配置 mysql.database 无效：库名须为一到六十四个字符，不能包含路径分隔符、点、空字符、扩展 Unicode 字符或末尾空格', 500)
        if type(self.port) is not int or not 1 <= self.port <= 65535:
            raise ServiceError('MySQL 端口必须是一到六万五千五百三十五之间的整数', 500)

    @property
    def url(self):
        # 使用 URL.create 正确处理密码内的 @、: 等字符；不拼接或记录明文连接串。
        return URL.create('mysql+pymysql', username=self.user, password=self.password,
                          host=self.host, port=self.port, database=self.database,
                          query={'charset': 'utf8mb4'})

    @classmethod
    def from_settings(cls, settings):
        try:
            port = int(settings.get('PET_MYSQL_PORT', 3306))
        except (TypeError, ValueError):
            raise ServiceError('MySQL 端口配置无效，请填写整数', 500) from None
        return cls(host=settings.get('PET_MYSQL_HOST', '127.0.0.1'), port=port,
                   database=settings.get('PET_MYSQL_DATABASE', 'memory_pet'),
                   user=settings.get('PET_MYSQL_USER', 'memory_pet'),
                   password=settings.get('PET_MYSQL_PASSWORD', ''))

    @classmethod
    def from_url(cls, value):
        try:
            url = make_url(value)
            if url.drivername not in {'mysql', 'mysql+pymysql'}:
                raise ValueError
            return cls(url.host or '', url.port or 3306, url.database or '', url.username or '', url.password or '')
        except (TypeError, ValueError, SQLAlchemyError):
            raise ServiceError('数据库必须使用 MySQL，请在配置文件的 mysql 分组填写连接信息', 500) from None


class QueryResult:
    """统一为字典行，业务层不依赖驱动游标或连接生命周期。"""
    def __init__(self, result):
        self.result = result
        self.rowcount = result.rowcount

    def fetchone(self):
        row = self.result.mappings().fetchone()
        return dict(row) if row is not None else None

    def fetchall(self):
        return [dict(row) for row in self.result.mappings().fetchall()]


class DatabaseSession:
    def __init__(self, connection):
        self.connection = connection

    def execute(self, sql, params=()):
        return QueryResult(self.connection.exec_driver_sql(sql, tuple(params)))

    def executemany(self, sql, rows):
        # 空候选不能执行空批次，驱动会将其误判为缺少参数的单条语句。
        values = [tuple(row) for row in rows]
        if values:
            return QueryResult(self.connection.exec_driver_sql(sql, values))
        return None


class MySQLDatabase:
    def __init__(self, config):
        self.config = config if isinstance(config, DatabaseConfig) else DatabaseConfig.from_url(config)
        self.engine = create_engine(
            self.config.url, pool_size=5, max_overflow=5, pool_timeout=5,
            pool_pre_ping=True, pool_recycle=1800, hide_parameters=True,
            isolation_level='READ COMMITTED',
            connect_args={'connect_timeout': 5, 'read_timeout': 10, 'write_timeout': 10},
        )

    @contextmanager
    def db(self):
        try:
            with self.engine.begin() as connection:
                yield DatabaseSession(connection)
        except IntegrityError:
            # 唯一键冲突由账号或业务层转成对应中文错误，不能吞掉约束。
            raise
        except SQLAlchemyError:
            raise ServiceError('MySQL 数据库暂不可用，请检查连接配置、数据库权限和服务状态', 503) from None

    def close(self):
        self.engine.dispose()


@dataclass(frozen=True)
class SQLiteConfig:
    """本机测试用 SQLite 文件；生产仍应使用 MySQL。"""
    path: str = 'memory_pet.sqlite3'

    @property
    def url(self):
        return URL.create('sqlite', database=self.path)


_UPSERT = re.compile(r'\s+ON DUPLICATE KEY UPDATE\s+(.*)$', re.S | re.I)


def sqlite_sql(sql):
    """把业务层的 MySQL 方言语句翻译成 SQLite 可执行的等价语句。"""
    sql = re.sub(r'\s+FOR UPDATE\s*$', '', sql, flags=re.I)
    match = _UPSERT.search(sql)
    if match:
        head, tail = sql[:match.start()], match.group(1)
        # `col=col` 形式表示冲突时保持原行不变。
        if re.fullmatch(r'(\w+)=\1', tail.strip()):
            tail = 'ON CONFLICT DO NOTHING'
        else:
            tail = re.sub(r'VALUES\((\w+)\)', r'excluded.\1', tail)
            tail = 'ON CONFLICT DO UPDATE SET ' + re.sub(r'\bIF\(', 'iif(', tail)
        sql = f'{head} {tail}'
    return sql.replace('%s', '?')


class SQLiteSession(DatabaseSession):
    def execute(self, sql, params=()):
        return super().execute(sqlite_sql(sql), params)

    def executemany(self, sql, rows):
        return super().executemany(sqlite_sql(sql), rows)


class SQLiteDatabase:
    def __init__(self, config):
        self.config = config
        self.engine = create_engine(self.config.url, hide_parameters=True,
                                    connect_args={'timeout': 10, 'check_same_thread': False})

        @event.listens_for(self.engine, 'connect')
        def prepare(connection, _):
            # 与 MySQL 的 SHA2/UNHEX 对齐，使绑定表的服务地址摘要写法无需分支。
            connection.create_function('SHA2', 2, lambda value, bits: hashlib.sha256(value.encode()).hexdigest(), deterministic=True)
            connection.create_function('UNHEX', 1, lambda value: bytes.fromhex(value), deterministic=True)
            connection.execute('PRAGMA journal_mode=WAL')

    @contextmanager
    def db(self):
        try:
            with self.engine.begin() as connection:
                yield SQLiteSession(connection)
        except IntegrityError:
            raise
        except SQLAlchemyError:
            raise ServiceError('SQLite 数据库暂不可用，请检查数据库文件路径和权限', 503) from None

    def close(self):
        self.engine.dispose()
