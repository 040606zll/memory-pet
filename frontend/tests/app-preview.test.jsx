import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
vi.mock('../src/api.js', () => ({ api: vi.fn(async () => ({ connected: false })), patch: vi.fn(), post: vi.fn(), streamChat: vi.fn(), openAsrSocket: vi.fn() }));
vi.mock('../src/RobotDog.jsx', () => ({ RobotDog: () => <div>预览角色</div>, RobotDogAvatar: () => <span /> }));

it('分享的正式对话预览链接从正确模式打开，退出后可重新开启语音', async () => {
  window.history.replaceState({}, '', '/?preview=chat');
  try {
    const { App } = await import('../src/App.jsx');
    render(<App />);
    expect(screen.getByRole('tab', { name: '正式对话' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('原型预览')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '退出原型预览' }));
    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭语音朗读' }));
    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }));
    fireEvent.click(screen.getByRole('button', { name: '开启语音朗读' }));
    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }));
    expect(screen.getByRole('button', { name: '关闭语音朗读' })).toBeInTheDocument();
  } finally { window.history.replaceState({}, '', '/'); }
});
