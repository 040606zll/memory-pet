"""仅检验已确认测试记忆的真实召回，不保存或显示凭据。"""
import re
import subprocess
from pathlib import Path
import uuid
import httpx

root = Path(__file__).resolve().parents[5]
pid = (root / '.runtime/backend.pid').read_text().strip()
raw = subprocess.check_output(['ps', 'eww', '-p', pid, '-o', 'command='], text=True)
def value(name):
    result = re.search(r'(?:^| )' + name + r'=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|$)', raw)
    if not result: raise RuntimeError('运行进程缺少连接配置')
    return result.group(1).strip()
expected = 'd7bcd0b5-b224-418b-8b31-bde57571c47b'
with httpx.Client(base_url=value('MEMORYOS_BASE_URL'), headers={'X-API-Key':value('MEMORYOS_API_KEY')}, trust_env=False, timeout=30) as c:
    r=c.post('/recall',json={'user_id':value('MEMORYOS_USER_ID'),'query':'我最喜欢的测试饮料是什么？','top_k':5,'sources':['memory'],'request_id':str(uuid.uuid4()),'with_persona':False})
    r.raise_for_status()
    facts=r.json()['facts']
    ids=[str(row.get('memory_id') or row.get('id') or row.get('item_id') or '') for row in facts]
    print('召回候选数：',len(facts),'已写入测试记忆是否命中：',expected in ids)
    assert expected in ids,'新会话未召回已确认的测试饮料记忆'
