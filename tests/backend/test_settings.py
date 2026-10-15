"""真实配置文件加载回归，测试密钥均为替身，不读取开发者的本机密钥。"""
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from pet import settings
from pet.config import Connection
from pet.errors import ServiceError
from pet.main import create_app
from test_api import Remote, USER, data, login, session, chat


@pytest.fixture
def files(tmp_path, monkeypatch):
    for fields in settings.FIELDS.values():
        for name in fields.values():
            monkeypatch.delenv(name, raising=False)
    primary = tmp_path / "config.toml"
    local = tmp_path / "config.local.toml"
    monkeypatch.setattr(settings, "CONFIG_FILE", primary)
    monkeypatch.setattr(settings, "LOCAL_CONFIG_FILE", local)
    return primary, local


def test_file_configuration_connects_with_real_loader_and_private_model_status(files, mysql_config):
    primary, local = files
    primary.write_text('[llm]\nbase_url="https://file-model/v1"\napi_key="file-secret"\nmodel="file-model"\n'
                       '[memoryos]\nbase_url="http://memory"\napi_key="memory-secret"\nuser_id="' + USER + '"\n'
                       '[mysql]\nhost="127.0.0.1"\nport=3306\ndatabase="file_test"\nuser="test"\npassword="file-password"\n', encoding="utf-8")
    local.write_text('[llm]\napi_key="local-secret"\n', encoding="utf-8")
    remote = Remote()
    targets = []

    def handle(request):
        targets.append(str(request.url))
        return remote.handle(request)

    app = create_app(database=mysql_config, transport=httpx.MockTransport(handle))
    with TestClient(app) as client:
        login(client)
        public = data(client.post("/api/connection", json={}))
        assert public["connected"] and public["llm"] == {"configured": True}
        assert "secret" not in str(public) and "file-model" not in str(public)
        assert not any(url.endswith("/chat/completions") for url in targets)
        chat(client, session(client), rid="file-config")
    assert "https://file-model/v1/chat/completions" in targets
    call = next(call for call in remote.calls if call[1] == "/v1/chat/completions")
    assert call[4]["authorization"] == "Bearer local-secret" and call[2]["model"] == "file-model"
    assert app.state.store.config == mysql_config


def test_environment_overrides_files_without_mutating_either(files, monkeypatch):
    primary, local = files
    primary.write_text('[llm]\nbase_url="https://default-model/v1"\napi_key="default-secret"\nmodel="default-model"', encoding="utf-8")
    local.write_text('[llm]\napi_key="local-secret"', encoding="utf-8")
    original = local.read_bytes()
    monkeypatch.setenv("LLM_API_KEY", "environment-secret")
    monkeypatch.setenv("PET_MYSQL_DATABASE", "environment_test")
    values = settings.load_settings()
    assert values["LLM_API_KEY"] == "environment-secret"
    assert values["LLM_MODEL"] == "default-model"
    assert values["PET_MYSQL_DATABASE"] == "environment_test"
    assert local.read_bytes() == original
    # 显式空环境值也是覆盖，不偷偷使用文件中的旧密钥。
    monkeypatch.setenv("LLM_API_KEY", "")
    assert Connection.environment().llm_key == ""


def test_missing_files_still_support_environment_only_deployment(files, monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "https://environment-model/v1")
    monkeypatch.setenv("LLM_API_KEY", "environment-secret")
    monkeypatch.setenv("LLM_MODEL", "environment-model")
    config = Connection.environment()
    assert (config.llm_url, config.llm_key, config.model) == ("https://environment-model/v1", "environment-secret", "environment-model")


def test_mysql_configuration_ignores_launch_directory(files, monkeypatch, tmp_path):
    primary, local = files
    primary.write_text('[mysql]\nhost="db.example.test"\nport=3306\ndatabase="default_test"\nuser="test"\npassword="primary-secret"')
    local.write_text('[mysql]\ndatabase="local_test"\nport="3307"\npassword="local-secret"')
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    values = settings.load_settings()
    assert values["PET_MYSQL_DATABASE"] == "local_test"
    assert str(values["PET_MYSQL_PORT"]) == "3307"
    assert values["PET_MYSQL_PASSWORD"] == "local-secret"
    assert values["PET_MYSQL_HOST"] == "db.example.test"


def test_legacy_sqlite_configuration_is_rejected(files):
    files[0].write_text('[storage]\ndatabase="data/pet.sqlite3"')
    with pytest.raises(ServiceError):
        settings.load_settings()


@pytest.mark.parametrize("content", [
    '[llm]\napi_key="secret-marker',
    '[unknown]\napi_key="secret-marker"',
    'llm="secret-marker"',
    '[llm]\nunknown="secret-marker"',
    '[llm]\napi_key=123',
])
def test_invalid_file_fails_in_chinese_without_echoing_configuration(files, content):
    files[0].write_text(content, encoding="utf-8")
    with pytest.raises(ServiceError) as error:
        settings.load_settings()
    assert error.value.status == 500 and "后端配置" in error.value.message
    assert "secret-marker" not in str(error.value)


def test_unreadable_file_fails_instead_of_silent_fallback(files):
    files[0].mkdir()
    with pytest.raises(ServiceError, match="后端配置文件无法读取"):
        settings.load_settings()


@pytest.mark.parametrize('address', ['https://memory.test:invalid', 'http://memory.test:65536', 'http://[broken'])
def test_invalid_url_port_or_ipv6_is_an_actionable_config_error(address):
    from pet.config import validated_url
    with pytest.raises(ServiceError): validated_url(address)


def test_connection_readiness_and_secret_rotation_preserve_only_valid_ownership():
    from pet.schemas import ConnectBody
    from dataclasses import replace
    base = Connection('http://memory.test','old-key',USER,'https://model.test/v1','model-key','model')
    with pytest.raises(ServiceError) as not_connected: replace(base, user_id='').ready()
    assert not_connected.value.status == 503
    with pytest.raises(ServiceError) as address_changed:
        base.update(ConnectBody(memoryos={'base_url':'https://other.test'}))
    assert address_changed.value.status == 422
    with pytest.raises(ServiceError) as invalid_uuid:
        base.update(ConnectBody(memoryos={'base_url':base.memory_url,'user_id':'invalid'}))
    assert invalid_uuid.value.status == 400
    retained=base.update(ConnectBody(memoryos={'base_url':base.memory_url}))
    assert retained == base
    rotated=base.update(ConnectBody(memoryos={'base_url':base.memory_url,'api_key':'new-key'}))
    assert rotated.memory_key == 'new-key' and rotated.user_id == ''
    explicit=base.update(ConnectBody(memoryos={'base_url':base.memory_url,'user_id':USER}))
    assert explicit.user_id == USER and explicit.llm_key == base.llm_key


def test_missing_model_configuration_is_actionable_before_a_remote_call():
    with pytest.raises(ServiceError) as failure: Connection().model_ready()
    assert failure.value.status == 428


@pytest.mark.parametrize('configured',[False,True])
def test_public_connection_summary_exposes_only_configuration_state(configured):
    config=Connection('https://memory.test','private-memory' if configured else '',USER if configured else '', 'https://model.test/v1' if configured else '', 'private-model' if configured else '', 'test-model' if configured else '')
    public=config.public()
    assert public == {'memoryos':{'base_url':'https://memory.test','user_id':USER if configured else '', 'configured':configured},'llm':{'configured':configured}}
    assert 'private' not in str(public) and 'test-model' not in str(public)
