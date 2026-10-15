"""通过启动时的真实配置入口复现库名误拦截，不连接或修改数据库。"""
import pytest

from pet.database import DatabaseConfig, MySQLDatabase
from pet.errors import ServiceError


@pytest.mark.parametrize('name', ['memory-pet', '宠物记忆', '宠物-memory', 'a' * 64, 'select', '123', 'pet;DROP_TABLE', 'pet@home', 'pet`name', 'pet name'])
def test_startup_accepts_mysql_database_names_without_changing_them(name):
    config = DatabaseConfig.from_settings({'PET_MYSQL_DATABASE': name})
    assert config.database == name
    assert config.url.database == name


@pytest.mark.parametrize('name', ['memory-pet', '宠物记忆', 'pet;DROP_TABLE', 'pet`name'])
def test_database_name_reaches_driver_as_connection_parameter_without_sql_interpolation(name):
    store = MySQLDatabase(DatabaseConfig(database=name))
    try:
        _, parameters = store.engine.dialect.create_connect_args(store.engine.url)
        assert parameters['database'] == name
        assert store.engine.pool.checkedout() == 0
    finally:
        store.close()


@pytest.mark.parametrize('field,value,expected', [
    ('HOST', '', 'mysql.host'), ('HOST', '   ', 'mysql.host'),
    ('USER', '', 'mysql.user'), ('USER', '   ', 'mysql.user'),
    ('DATABASE', '', 'mysql.database'), ('DATABASE', 'a' * 65, 'mysql.database'),
    ('DATABASE', 'pet/db', 'mysql.database'), ('DATABASE', 'pet\\db', 'mysql.database'),
    ('DATABASE', 'pet.db', 'mysql.database'), ('DATABASE', 'pet ', 'mysql.database'),
    ('DATABASE', 'pet\x00db', 'mysql.database'), ('DATABASE', 'pet🐶', 'mysql.database'),
    ('DATABASE', 'pet\ud800', 'mysql.database'),
    ('HOST', None, 'mysql.host'), ('USER', None, 'mysql.user'), ('DATABASE', None, 'mysql.database'),
])
def test_invalid_startup_configuration_identifies_field_without_echoing_values(field, value, expected):
    with pytest.raises(ServiceError) as error:
        DatabaseConfig.from_settings({'PET_MYSQL_' + field: value, 'PET_MYSQL_PASSWORD': 'private-marker'})
    assert expected in error.value.message
    assert 'private-marker' not in str(error.value)
    assert error.value.status == 500
