import { spawn } from 'node:child_process'
const children = [
  spawn(
    process.execPath,
    ['--experimental-strip-types', '--watch', 'src/http/server.ts'],
    { stdio: 'inherit' },
  ),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], {
    stdio: 'inherit',
  }),
]
function stop() {
  for (const child of children) child.kill()
  process.exit()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const child of children) child.on('exit', stop)
