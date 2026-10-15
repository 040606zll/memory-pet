"""显式执行少量真实模型验证；仅使用测试句和构造记忆，不访问 MySQL 或 MemoryOS。"""
import argparse
import asyncio
import json
from pathlib import Path
import sys

import httpx

ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(ROOT / 'backend'))
from pet.config import Connection
from pet.errors import ServiceError
from pet.providers import Providers


async def main():
    connection = Connection.environment()
    connection.model_ready()
    memory = [{'id': 'synthetic-name', 'content': '用户给宠物狗起的称呼是“羊狗”', 'source': '专用构造测试数据'}]
    cases = [
        ('当前明确起名', 'training', '你叫羊狗', [], [], '羊狗'),
        ('空历史命名记忆召回', 'chat', '你叫什么名字？', [], memory, '羊狗'),
        ('新名字覆盖旧名字', 'training', '你不叫羊狗，以后你叫团团', [], memory, '团团'),
        ('区分用户与宠物名字', 'chat', '我叫阿明，你叫什么名字？', [], memory, '羊狗'),
        ('本会话新名字不被旧记忆回滚', 'chat', '你叫什么名字？', [{'role': 'user', 'content': '以后你叫团团'}, {'role': 'assistant', 'content': '好呀，现在叫我团团吧，确认后才能长期保存。'}], memory, '团团'),
    ]
    rows = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(45, connect=10), trust_env=False) as client:
        for label, mode, content, history, memories, expected in cases:
            try:
                output = await Providers(client).reply(connection, mode, content, history, memories, '小忆')
                row = {'case': label, 'expected': expected, 'pet_name': output.pet_name,
                       'reply_uses_name': expected in output.reply,
                       'passed': output.pet_name == expected and expected in output.reply and '我是小忆' not in output.reply}
            except ServiceError as error:
                row = {'case': label, 'passed': False, 'status': error.status, 'error': error.message}
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
    target = ROOT / 'docs/2026-10-15/宠物名字冲突/真实模型验证.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({'scope': '仅真实模型；记忆为构造数据，未验证数据库或MemoryOS', 'cases': rows}, ensure_ascii=False, indent=2) + '\n')
    return 0 if all(row['passed'] for row in rows) else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-live', required=True, action='store_true', help='确认执行五次真实模型调用')
    parser.parse_args()
    raise SystemExit(asyncio.run(main()))
