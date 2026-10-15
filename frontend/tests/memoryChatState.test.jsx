import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),post:vi.fn(),patch:vi.fn()}));
vi.mock('../src/api.js',()=>mocks);
import { useMemoryChat } from '../src/MemoryChatState.js';
const connected={connected:true};
const candidate={id:'candidate',content:'用户喜欢雨声',status:'pending',memory_ids:[]};
const result={user_message:{id:'u',role:'user',content:'测试消息'},assistant_message:{id:'a',role:'assistant',content:'等待确认',candidates:[candidate]}};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
beforeEach(()=>{
  mocks.api.mockReset().mockImplementation(async path=>path==='/status'?connected:path.includes('/messages?')?{items:[],total_pages:1}:path.includes('/memories?')?{items:[],total:0}:{items:[],total_pages:1});
  mocks.post.mockReset().mockImplementation(async(path,body)=>path==='/sessions'?{id:'s',surface:'memory',mode:body.mode}:path.endsWith('/memories/confirm')?{...candidate,status:'confirmed',memory_ids:['real-test-id']}:result);
  mocks.patch.mockReset().mockImplementation(async(path,body)=>({...candidate,...body}));
});
async function ready(){const view=renderHook(()=>useMemoryChat());await waitFor(()=>expect(view.result.current.status).toEqual(connected));view.result.current.scrollRef.current=document.createElement('div');view.result.current.inputRef.current=document.createElement('textarea');return view;}
async function send(view){await act(async()=>view.result.current.setDraft('测试消息'));await act(async()=>view.result.current.send());}

it('requires a connection and ignores empty or unavailable operations',async()=>{
  mocks.api.mockResolvedValue({connected:false});const view=renderHook(()=>useMemoryChat());await waitFor(()=>expect(view.result.current.status).toEqual({connected:false}));
  await act(async()=>{await view.result.current.send();await view.result.current.earlier();await view.result.current.confirm(candidate);await view.result.current.candidateMutation(candidate,'内容');view.result.current.memorySearch();});
  await act(async()=>{await view.result.current.createSession('training');await view.result.current.viewMemories();});expect(view.result.current.connectionOpen).toBe(true);expect(mocks.post).not.toHaveBeenCalled();
});
it('recovers from initial status/list failures and tolerates missing list metadata',async()=>{
  mocks.api.mockRejectedValueOnce(new Error('状态不可用'));const view=renderHook(()=>useMemoryChat());await waitFor(()=>expect(view.result.current.error).toBe('状态不可用'));
  mocks.api.mockRejectedValueOnce(new Error('列表不可用'));await act(async()=>view.result.current.refreshSessions());expect(view.result.current.error).toBe('列表不可用');
  mocks.api.mockResolvedValueOnce({});await act(async()=>view.result.current.refreshSessions(2));expect(view.result.current.sessions).toEqual([]);expect(view.result.current.sessionPage).toBe(2);expect(view.result.current.sessionPages).toBe(1);
});
it('creates both modes, preserves drafts and restores each view independently',async()=>{
  const view=await ready();await act(async()=>view.result.current.setDraft('保留草稿'));await act(async()=>view.result.current.createSession('training'));
  expect(view.result.current.draft).toBe('保留草稿');await act(async()=>view.result.current.createSession('chat'));expect(view.result.current.mode).toBe('chat');expect(view.result.current.draft).toBe('');
  await act(async()=>view.result.current.changeMode('training'));expect(view.result.current.draft).toBe('保留草稿');await act(async()=>view.result.current.changeMode('training'));
  await act(async()=>view.result.current.changeMode('chat'));expect(view.result.current.session.mode).toBe('chat');
});
it('rejects a wrong surface and can cancel session creation even when transport ignores AbortSignal',async()=>{
  const view=await ready();mocks.post.mockResolvedValueOnce({id:'pet',surface:'pet'});await act(async()=>view.result.current.createSession('chat'));expect(view.result.current.error).toContain('类型不匹配');
  const pending=deferred();mocks.post.mockReturnValueOnce(pending.promise);let task;act(()=>{task=view.result.current.createSession('training');});act(()=>view.result.current.cancel());await act(async()=>{pending.resolve({id:'late',surface:'memory'});await task;});expect(view.result.current.session).toBe(null);expect(view.result.current.busy).toBe(false);expect(view.result.current.error).toContain('取消');
});
it('serializes operations, rejects empty edits, preserves failed candidates and refreshes an open memory drawer on confirmation',async()=>{
  const view=await ready();await send(view);expect(view.result.current.messages).toEqual([result.user_message,result.assistant_message]);
  expect(await act(async()=>view.result.current.candidateMutation(candidate,'   '))).toBe(false);expect(view.result.current.error).toContain('不能为空');
  mocks.patch.mockRejectedValueOnce(new Error('修改失败'));await act(async()=>view.result.current.candidateMutation(candidate,'修改'));expect(view.result.current.error).toBe('修改失败');expect(view.result.current.messages[1].candidates[0].status).toBe('pending');
  await act(async()=>view.result.current.viewMemories());expect(view.result.current.memoryOpen).toBe(true);await act(async()=>view.result.current.confirm(candidate));expect(view.result.current.messages[1].candidates[0].status).toBe('confirmed');
  expect(mocks.api.mock.calls.filter(([path])=>path.includes('/memories?'))).toHaveLength(2);
  const pending=deferred();mocks.patch.mockReturnValueOnce(pending.promise);let task;act(()=>{task=view.result.current.candidateMutation(candidate,'修改');});await act(async()=>{await view.result.current.send();await view.result.current.createSession('chat');await view.result.current.openSession({id:'other'});await view.result.current.confirm(candidate);await view.result.current.earlier();await view.result.current.viewMemories();await view.result.current.candidateMutation(candidate,'另一个修改');view.result.current.changeMode('chat');});
  expect(view.result.current.mode).toBe('training');await act(async()=>{pending.resolve({...candidate,content:'修改'});await task;});expect(view.result.current.messages[1].candidates[0].content).toBe('修改');
});
it('ignores stale session lists and their late failures without overwriting the latest result',async()=>{
  const view=await ready();for(const rejected of [false,true]){const pending=deferred();mocks.api.mockReturnValueOnce(pending.promise);let task;act(()=>{task=view.result.current.refreshSessions(1);});mocks.api.mockResolvedValueOnce({items:[{id:'new'}],total_pages:2});await act(async()=>view.result.current.refreshSessions(2));await act(async()=>{rejected?pending.reject(new Error('旧失败')):pending.resolve({items:[{id:'old'}]});await task;});expect(view.result.current.sessions).toEqual([{id:'new'}]);expect(view.result.current.error).not.toBe('旧失败');}
});
it('loads paginated history, merges older messages without duplicates and reports a failed older page',async()=>{
  const view=await ready();mocks.api.mockImplementation(async path=>path==='/status'?connected:path.includes('/messages?page=2')?{items:[{id:'new',content:'最新'}]}:path.includes('/messages?page=1')?{items:[{id:'old',content:'较早'}],total_pages:2}:{items:[],total_pages:1});
  await act(async()=>view.result.current.openSession({id:'history',surface:'memory',mode:'chat'}));expect(view.result.current.messagePage).toBe(2);expect(view.result.current.messages[0].id).toBe('new');
  mocks.api.mockRejectedValueOnce(new Error('更早消息不可用'));await act(async()=>view.result.current.earlier());expect(view.result.current.error).toBe('更早消息不可用');expect(view.result.current.messagePage).toBe(2);
  mocks.api.mockResolvedValueOnce({items:[{id:'old'},{id:'new'}]});await act(async()=>view.result.current.earlier());expect(view.result.current.messages.map(m=>m.id)).toEqual(['old','new']);expect(view.result.current.messagePage).toBe(1);
  await act(async()=>view.result.current.openSession({id:'foreign',surface:'pet',mode:'chat'}));expect(view.result.current.error).toContain('不属于');
});
it('retains drafts after failed history/memory loads and tolerates empty history or memory metadata',async()=>{
  const view=await ready();mocks.api.mockRejectedValueOnce(new Error('历史失败'));await act(async()=>view.result.current.openSession({id:'h',mode:'training'}));expect(view.result.current.error).toBe('历史失败');
  mocks.api.mockResolvedValueOnce({});await act(async()=>view.result.current.openSession({id:'h',mode:'training'}));expect(view.result.current.messages).toEqual([]);
  mocks.api.mockRejectedValueOnce(new Error('记忆失败'));await act(async()=>view.result.current.viewMemories());expect(view.result.current.error).toBe('记忆失败');expect(view.result.current.memoriesLoading).toBe(false);
  mocks.api.mockResolvedValueOnce({});await act(async()=>view.result.current.memorySearch());expect(view.result.current.memories).toEqual([]);expect(view.result.current.memoryTotal).toBe(0);
});
it('reconnection invalidates old history and edit callbacks and only keeps the latest status',async()=>{
  const view=await ready();await send(view);const pending=deferred();mocks.patch.mockReturnValueOnce(pending.promise);let edit;act(()=>{edit=view.result.current.candidateMutation(candidate,'旧修改');});
  await act(async()=>view.result.current.connected());await act(async()=>{pending.resolve({...candidate,content:'旧修改'});await edit;});expect(view.result.current.messages).toEqual([]);expect(view.result.current.busy).toBe(false);
  mocks.api.mockRejectedValueOnce(new Error('重连失败'));await act(async()=>view.result.current.connected());expect(view.result.current.error).toBe('重连失败');
  const old=deferred();mocks.api.mockReturnValueOnce(old.promise);let oldTask;act(()=>{oldTask=view.result.current.connected();});await act(async()=>view.result.current.connected());await act(async()=>{old.resolve({connected:false});await oldTask;});expect(view.result.current.status).toEqual(connected);
});
it.each(['status','history','session','memories','view','confirm','chat'])('ignores a late %s result after unmount and releases pending work',async kind=>{
  const pending=deferred();let view,task;
  if(kind==='status'){mocks.api.mockReturnValueOnce(pending.promise);view=renderHook(()=>useMemoryChat());view.unmount();await act(async()=>pending.reject(new Error('late status')));return;}
  view=await ready();if(['memories','confirm','chat'].includes(kind))await send(view);
  if(kind==='session'){mocks.post.mockReturnValueOnce(pending.promise);act(()=>{task=view.result.current.createSession('chat');});}
  if(kind==='history'){mocks.api.mockReturnValueOnce(pending.promise);act(()=>{task=view.result.current.openSession({id:'history',mode:'chat'});});}
  if(kind==='memories'){mocks.api.mockReturnValueOnce(pending.promise);act(()=>{task=view.result.current.memorySearch();});}
  if(kind==='view'){mocks.post.mockReturnValueOnce(pending.promise);act(()=>{task=view.result.current.viewMemories();});}
  if(kind==='confirm'){mocks.post.mockReturnValueOnce(pending.promise);act(()=>{task=view.result.current.confirm(candidate);});}
  if(kind==='chat'){mocks.post.mockReturnValueOnce(pending.promise);act(()=>{task=view.result.current.send({content:'重试',request_id:'retry'});});}
  view.unmount();await act(async()=>{pending.resolve(kind==='history'?{items:[]}:kind==='memories'?{items:[]}:kind==='confirm'?{...candidate,status:'confirmed',memory_ids:['id']}:kind==='chat'?result:{id:'late',surface:'memory'});await task;});
});

it.each(['session', 'send', 'view'])('卸载发生在创建会话内部完成与外层恢复之间时忽略 %s 结果', async kind => {
  const view = await ready(), pending = deferred();
  mocks.post.mockReturnValueOnce(pending.promise);
  let task;
  act(() => {
    task = kind === 'session' ? view.result.current.createSession('chat')
      : kind === 'send' ? view.result.current.send({ content: '消息', request_id: 'race' })
        : view.result.current.viewMemories();
  });
  await act(async () => {
    pending.resolve({ id: 'late', surface: 'memory' });
    queueMicrotask(() => view.unmount());
    await task;
  });
  expect(mocks.post.mock.calls).toHaveLength(1);
});

it('已存在会话的记忆抽屉和更早消息在卸载后停止更新，拒绝候选走状态接口', async () => {
  const view = await ready(); await send(view);
  await act(async () => view.result.current.candidateMutation(candidate, '', true));
  expect(mocks.patch).toHaveBeenLastCalledWith('/sessions/s/candidates/candidate', { status: 'rejected' });
  mocks.api.mockResolvedValueOnce({ items: [], total_pages: 2 }).mockResolvedValueOnce({ items: [] });
  await act(async () => view.result.current.openSession({ id: 'pages', mode: 'chat' }));
  const pending = deferred(); mocks.api.mockReturnValueOnce(pending.promise);
  let task; act(() => { task = view.result.current.earlier(); });
  view.unmount();
  await act(async () => { pending.resolve({ items: [{ id: 'late' }] }); await task; });
});

it('重连新状态成功后忽略旧状态错误，卸载后迟到记忆错误也不写入状态', async () => {
  const view = await ready(), old = deferred();
  mocks.api.mockReturnValueOnce(old.promise);
  let task; act(() => { task = view.result.current.connected(); });
  await act(async () => view.result.current.connected());
  await act(async () => { old.reject(new Error('旧重连错误')); await task; });
  expect(view.result.current.error).toBe('');
  await send(view);
  const memory = deferred(); mocks.api.mockReturnValueOnce(memory.promise);
  act(() => { task = view.result.current.memorySearch(); });
  view.unmount();
  await act(async () => { memory.reject(new Error('旧记忆错误')); await task; });
});
