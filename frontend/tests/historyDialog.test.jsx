import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/api.js', () => ({ api: mocks.api }));
import { HistoryDialog } from '../src/HistoryDialog.jsx';
beforeEach(() => { mocks.api.mockReset(); });
const entry = (id, mode = 'training', title = '') => ({ id, mode, title, created_at: '2026-10-15T00:00:00Z' });
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise, resolve, reject}; };

it('paginates, labels untitled modes and awaits choosing a session', async () => {
  mocks.api.mockImplementation(async path => path.includes('page=2') ? {items:[entry('b','chat')],total_pages:2} : {items:[entry('a')],total_pages:2});
  const chosen=deferred(), onChoose=vi.fn(() => chosen.promise), onClose=vi.fn();
  render(<HistoryDialog onClose={onClose} onChoose={onChoose} />);
  await screen.findByRole('button',{name:/训练对话/}); expect(screen.getByRole('button',{name:'上一页'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'下一页'})); await screen.findByRole('button',{name:/正式对话/});
  expect(screen.getByRole('button',{name:'下一页'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'上一页'})); await screen.findByRole('button',{name:/训练对话/});
  fireEvent.click(screen.getByRole('button',{name:/训练对话/})); expect(screen.getByRole('status')).toHaveTextContent('正在读取');
  await act(async () => chosen.resolve()); await screen.findByRole('button',{name:/训练对话/});
  fireEvent(screen.getByRole('dialog'), new Event('cancel', {bubbles:true})); expect(onClose).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button',{name:'关闭历史对话'})); expect(onClose).toHaveBeenCalledTimes(2);
});
it('handles missing list metadata and safe read errors, including late responses after unmount', async () => {
  mocks.api.mockResolvedValueOnce({}); const view=render(<HistoryDialog onClose={vi.fn()} onChoose={vi.fn()} surface="memory" />);
  await screen.findByText('还没有历史对话。'); expect(mocks.api).toHaveBeenCalledWith('/sessions?surface=memory&page=1&limit=20');
  mocks.api.mockRejectedValueOnce(new Error('历史服务暂不可用')); view.rerender(<HistoryDialog onClose={vi.fn()} onChoose={vi.fn()} />);
  await screen.findByRole('alert'); expect(screen.getByRole('alert')).toHaveTextContent('历史服务暂不可用'); view.unmount();
  for (const rejected of [false,true]) {
    const request=deferred(); mocks.api.mockReturnValueOnce(request.promise);
    const late=render(<HistoryDialog onClose={vi.fn()} onChoose={vi.fn()} />); late.unmount();
    await act(async () => rejected ? request.reject(new Error('late failure')) : request.resolve({items:[],total_pages:1}));
  }
});
it('reports a failed session selection and remains usable for another selection', async () => {
  mocks.api.mockResolvedValue({items:[entry('a','training','测试会话')],total_pages:1});
  const onChoose=vi.fn().mockRejectedValueOnce(new Error('消息加载失败')).mockResolvedValueOnce(undefined);
  render(<HistoryDialog onClose={vi.fn()} onChoose={onChoose} />); fireEvent.click(await screen.findByRole('button',{name:/测试会话/}));
  expect(await screen.findByRole('alert')).toHaveTextContent('消息加载失败'); fireEvent.click(screen.getByRole('button',{name:/测试会话/}));
  await waitFor(() => expect(onChoose).toHaveBeenCalledTimes(2));
});
