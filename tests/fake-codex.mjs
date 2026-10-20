#!/usr/bin/env node
// 測試用的假 Codex（不花額度）：記下伺服器怎麼叫它（codex-args.json），再照範例交一個風扇裝置。
import { cpSync, writeFileSync } from 'node:fs';

writeFileSync('codex-args.json', JSON.stringify(process.argv.slice(2)));
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
out({ type: 'thread.started', thread_id: 'fake' });
out({ type: 'turn.started' });
cpSync('examples/fan-device/part.js', 'part.js');
cpSync('examples/fan-device/meta.json', 'meta.json');
out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '（假 Codex）照範例交了一個風扇' } });
out({ type: 'turn.completed' });
