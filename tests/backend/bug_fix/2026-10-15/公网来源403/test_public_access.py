"""通过真实应用与配置加载复现公网 Host、Origin 403，不访问真实上游。"""
from pathlib import Path
import sys

import pytest
from fastapi.testclient import TestClient

ROOT = next(path for path in Path(__file__).resolve().parents if (path / "backend/start.sh").is_file())
sys.path.insert(0, str(ROOT / "backend"))
from pet import settings
from pet.errors import ServiceError
from pet.main import create_app
from pet.database import DatabaseConfig
from pet.store import Store


@pytest.fixture
def deployment(tmp_path, monkeypatch):
    # 来源策略只读取请求头，不执行数据库查询；跳过生命周期建表即可独立验证。
    monkeypatch.setattr(Store, "initialize", lambda self: None)
    for fields in settings.FIELDS.values():
        for name in fields.values():
            monkeypatch.delenv(name, raising=False)
    primary = tmp_path / "config.toml"
    local = tmp_path / "config.local.toml"
    monkeypatch.setattr(settings, "CONFIG_FILE", primary)
    monkeypatch.setattr(settings, "LOCAL_CONFIG_FILE", local)

    def client(hosts="", origins=""):
        primary.write_text('[server]\nallowed_hosts = "' + hosts + '"\nallowed_origins = "' + origins + '"\n')
        return TestClient(create_app(database=DatabaseConfig(database="memory_pet_test_policy")), base_url="http://81.71.39.10")

    return client, primary, local


def test_configured_public_ip_supports_get_and_browser_post(deployment):
    client, _, _ = deployment
    with client("81.71.39.10", "http://81.71.39.10") as browser:
        response = browser.get("/api/health")
        assert response.status_code == 200 and response.json()["data"]["status"] == "ok"
        response = browser.post("/api/disconnect", headers={"Origin": "http://81.71.39.10", "Sec-Fetch-Site": "same-origin"})
        assert response.status_code == 401


def test_default_remains_local_only(deployment):
    client, _, _ = deployment
    with client() as browser:
        response = browser.get("/api/health")
        assert response.status_code == 403 and response.json()["message"] == "此服务仅允许本机访问"
        assert browser.get("/api/health", headers={"host": "127.0.0.1:8797"}).status_code == 200


@pytest.mark.parametrize("headers", [
    {"host": "evil.test"},
    {"host": "81.71.39.10.evil.test"},
    {"host": "81.71.39.100"},
    {"host": "81.71.39.10@evil.test"},
    {"host": "["},
    {"host": "81.71.39.10:"},
    {"host": "81.71.39.10:0"},
    {"host": "81.71.39.10:99999"},
    {"host": "81.71.39.10/path"},
    {"host": "81.71.39.10?"},
    {"origin": "null"},
    {"origin": "https://81.71.39.10"},
    {"origin": "http://81.71.39.10:8080"},
    {"origin": "http://81.71.39.10.evil.test"},
    {"origin": "http://81.71.39.10@evil.test"},
    {"origin": "http://evil.test", "x-forwarded-host": "81.71.39.10"},
    {"origin": "http://81.71.39.10/path"},
    {"origin": "http://81.71.39.10?"},
    {"origin": "http://81.71.39.10#"},
    {"origin": "http://["},
    {"origin": "http://81.71.39.10:bad"},
    {"origin": "http://81.71.39.10", "sec-fetch-site": "cross-site"},
])
def test_public_whitelist_rejects_other_addresses_and_cross_site(deployment, headers):
    client, _, _ = deployment
    with client("81.71.39.10", "http://81.71.39.10") as browser:
        response = browser.post("/api/disconnect", headers=headers)
        assert response.status_code == 403
        assert response.json()["code"] == 403 and response.json()["data"] is None


@pytest.mark.parametrize("headers", [
    [("host", "81.71.39.10"), ("host", "evil.test")],
    [("origin", "http://81.71.39.10"), ("origin", "http://evil.test")],
    [("sec-fetch-site", "same-origin"), ("sec-fetch-site", "cross-site")],
])
def test_ambiguous_headers_cannot_bypass_policy(deployment, headers):
    client, _, _ = deployment
    with client("81.71.39.10", "http://81.71.39.10") as browser:
        assert browser.post("/api/disconnect", headers=headers).status_code == 403


@pytest.mark.parametrize("host,source", [
    ("81.71.39.10:80", "http://81.71.39.10:80"),
    ("PET.EXAMPLE.TEST", "https://PET.EXAMPLE.TEST:443"),
    ("pet.example.test:8443", "https://pet.example.test:8443"),
    ("[::1]:8797", "http://[::1]:8796"),
    ("localhost:8797", "http://localhost:8796"),
])
def test_exact_origins_normalize_case_and_default_ports(deployment, host, source):
    client, _, _ = deployment
    with client("81.71.39.10,pet.example.test", "http://81.71.39.10,https://pet.example.test,https://pet.example.test:8443") as browser:
        assert browser.post("/api/disconnect", headers={"host": host, "origin": source}).status_code == 401


@pytest.mark.parametrize("hosts,origins,field", [
    ("*", "", "allowed_hosts"),
    ("*.example.test", "", "allowed_hosts"),
    ("http://81.71.39.10", "", "allowed_hosts"),
    ("81.71.39.10:80", "", "allowed_hosts"),
    ("81.71.39.10,", "", "allowed_hosts"),
    ("-bad.test", "", "allowed_hosts"),
    ("a" * 254, "", "allowed_hosts"),
    ("", "*", "allowed_origins"),
    ("", "81.71.39.10", "allowed_origins"),
    ("", "ftp://81.71.39.10", "allowed_origins"),
    ("", "https://*.example.test", "allowed_origins"),
    ("", "http://81.71.39.10/path", "allowed_origins"),
    ("", "http://81.71.39.10?key=private-marker", "allowed_origins"),
    ("", "http://81.71.39.10:99999", "allowed_origins"),
    ("", "http://81.71.39.10:0", "allowed_origins"),
    ("", "http://user:private-marker@81.71.39.10", "allowed_origins"),
    ("", "http://81.71.39.10,", "allowed_origins"),
    ("", "http://81.71.39.10 bad", "allowed_origins"),
])
def test_invalid_configuration_fails_closed_without_echoing_values(deployment, hosts, origins, field):
    client, _, _ = deployment
    with pytest.raises(ServiceError) as error:
        client(hosts, origins)
    assert field in str(error.value) and "private-marker" not in str(error.value)


def test_local_file_and_environment_override_in_existing_order(deployment, monkeypatch, tmp_path):
    client, _, local = deployment
    # 本机覆盖文件替换同字段，未填写字段继续继承主配置。
    local.write_text('[server]\nallowed_origins="https://81.71.39.10"')
    with client("81.71.39.10", "http://81.71.39.10") as browser:
        assert browser.post("/api/disconnect", headers={"origin": "http://81.71.39.10"}).status_code == 403
        assert browser.post("/api/disconnect", headers={"origin": "https://81.71.39.10"}).status_code == 401
    monkeypatch.setenv("PET_ALLOWED_HOSTS", "pet.example.test")
    monkeypatch.setenv("PET_ALLOWED_ORIGINS", "https://pet.example.test")
    with TestClient(create_app(database=DatabaseConfig(database="memory_pet_test_policy")), base_url="https://pet.example.test") as browser:
        assert browser.post("/api/disconnect", headers={"origin": "https://pet.example.test"}).status_code == 401
        assert browser.get("/api/health", headers={"host": "81.71.39.10"}).status_code == 403


def test_bad_origin_cannot_be_hidden_by_rewriting_host_to_loopback(deployment):
    client, _, _ = deployment
    with client() as browser:
        assert browser.post("/api/disconnect", headers={"host": "127.0.0.1:8797", "origin": "http://evil.test"}).status_code == 403


def test_missing_host_is_rejected_without_unhandled_exception():
    from starlette.datastructures import Headers
    from pet.access import AccessPolicy
    assert AccessPolicy.from_settings({}).rejection(Headers()) == "此服务仅允许本机访问"
