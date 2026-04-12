import { spawn } from 'child_process';

const server = spawn('node', ['dist/index.js'], {
  env: {
    ...process.env,
    SUPABASE_URL: 'https://tnsqkpuvdiinzljnfubu.supabase.co',
    SUPABASE_SERVICE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRuc3FrcHV2ZGlpbnpsam5mdWJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMzU2NDMsImV4cCI6MjA5MDgxMTY0M30.qu4wpv-5h-DbFQQYR0kyLb9JTPyC5ShZLT6cOXxedeA',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
server.stdout.on('data', (data) => {
  buf += data.toString();
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (line.trim()) {
      try {
        const msg = JSON.parse(line);
        console.log('<<', JSON.stringify(msg, null, 2).slice(0, 500));
      } catch {
        console.log('<<', line.slice(0, 200));
      }
    }
  }
});

server.stderr.on('data', (data) => {
  console.error('[stderr]', data.toString().trim());
});

function send(msg) {
  const json = JSON.stringify(msg);
  console.log('>>', json.slice(0, 200));
  server.stdin.write(json + '\n');
}

// MCP handshake
setTimeout(() => {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } });
}, 500);

setTimeout(() => {
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}, 1500);

// Test tools/list
setTimeout(() => {
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
}, 2000);

// Test search
setTimeout(() => {
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_documents', arguments: { keyword: '교육', limit: 2 } } });
}, 3000);

// Test stats
setTimeout(() => {
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_collection_stats', arguments: {} } });
}, 4000);

setTimeout(() => {
  server.kill();
  process.exit(0);
}, 8000);
