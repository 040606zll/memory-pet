"""在独立 MySQL 测试库验证真实产品路径；沿用产品认证与真实 MemoryOS/模型/语音。
只绑定回环 18898，要求 PET_TEST_MYSQL_URL 指向明确的独立测试库。
"""
from pathlib import Path
import os
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from fastapi.responses import FileResponse
import uvicorn
from pet.database import DatabaseConfig
from pet.main import create_app

config = DatabaseConfig.from_url(os.environ['PET_TEST_MYSQL_URL'])
if '_test_' not in config.database:
    raise SystemExit('真实语音验收只允许独立 _test_ 数据库')
app = create_app(database=config)
dist = Path(__file__).resolve().parents[1] / 'frontend/dist/client'

@app.get('/{path:path}')
async def asset(path: str):
    target = (dist / path).resolve()
    if target.is_relative_to(dist.resolve()) and target.is_file(): return FileResponse(target)
    return FileResponse(dist / 'index.html')

async def server(scope, receive, send):
    if scope['type'] in {'http', 'websocket'} and scope['path'].startswith('/pet-api/'):
        scope = {**scope, 'path': '/api/' + scope['path'][len('/pet-api/'):], 'raw_path': ('/api/' + scope['path'][len('/pet-api/'):]).encode()}
    await app(scope, receive, send)

if __name__ == '__main__': uvicorn.run(server, host='127.0.0.1', port=18898, access_log=False)
