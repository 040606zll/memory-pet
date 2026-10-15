/** 原型数据只在用户明确打开预览时展示，绝不标成服务返回。 */
export function previewMessages(mode) {
  const timestamp = '2026-10-14T10:24:00';
  const memories = [{ id: 'preview-1', content: '疲惫时先陪伴' }, { id: 'preview-2', content: '喜欢听雨声' }];
  if (mode === 'training') return [
    { id: 'p1', role: 'user', content: '我累的时候，先安慰我，不要马上给建议。', created_at: timestamp },
    { id: 'p2', role: 'assistant', content: '我理解了：你累的时候，希望我先陪伴你，\n再问你需不需要建议。', created_at: timestamp, candidates: [] },
    { id: 'p3', role: 'user', content: '对，还有，我喜欢听雨声。', created_at: '2026-10-14T10:25:00' },
    { id: 'p4', role: 'assistant', content: '好，我会记住你的陪伴偏好和你喜欢的雨声。', created_at: '2026-10-14T10:25:00', candidates: [{ id: 'pc1', content: '疲惫时，先安慰，再询问是否需要建议', status: 'pending' }, { id: 'pc2', content: '喜欢听雨声', status: 'pending' }] },
  ];
  return [
    { id: 'p1', role: 'user', content: '今天工作好多，有点累。', created_at: timestamp },
    { id: 'p2', role: 'assistant', content: '辛苦啦，先歇一会儿。我陪你，不急着想办法。', created_at: timestamp, memories: [memories[0]] },
    { id: 'p3', role: 'user', content: '你还记得我喜欢什么声音吗？', created_at: '2026-10-14T10:25:00' },
    { id: 'p4', role: 'assistant', content: '当然，是雨声。要不要听着雨声，和我待一会儿？', created_at: '2026-10-14T10:25:00', memories: [memories[1]] },
  ];
}
export const PREVIEW_MEMORIES = [{ id: 'preview-1', content: '疲惫时先陪伴' }, { id: 'preview-2', content: '喜欢听雨声' }];
