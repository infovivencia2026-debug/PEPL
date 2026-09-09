import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { createHandler } from './router.ts'
import { buildRouter } from './app.ts'
import { router } from './routes.ts'

const handler=createHandler(buildRouter())
const domainHandler=createHandler(router)
const root=resolve('dist')
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'}
const server=createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff')
  res.setHeader('Referrer-Policy','same-origin')
  res.setHeader('X-Frame-Options','DENY')
  if(req.url?.startsWith('/api/')){
    if(!['GET','HEAD'].includes(req.method??'GET')){
      const origin=req.headers.origin
      if(origin && new URL(origin).host!==req.headers.host){res.writeHead(403);res.end(JSON.stringify({error:{message:'Request origin is not allowed'}}));return}
      if(!req.headers['content-type']?.startsWith('application/json')){res.writeHead(415);res.end(JSON.stringify({error:{message:'Use application/json'}}));return}
    }
    if(!req.headers.authorization){
      const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('pepl_session='))?.slice(13)
      if(token && /^[A-Za-z0-9_-]+$/.test(token))req.headers.authorization=`Bearer ${token}`
    }
    await (req.url.startsWith('/api/ui/')?handler:domainHandler)(req,res);return
  }
  try{
    const pathname=decodeURIComponent(new URL(req.url??'/','http://localhost').pathname)
    let path=resolve(root,`.${pathname}`)
    if(!path.startsWith(root+sep)&&path!==root){res.writeHead(404);res.end();return}
    if(!extname(path))path=resolve(root,'index.html')
    const body=await readFile(path)
    res.writeHead(200,{'Content-Type':mime[extname(path)]??'application/octet-stream','Cache-Control':extname(path)==='.html'?'no-cache':'public, max-age=3600'})
    res.end(body)
  }catch{res.writeHead(404);res.end('Page not found. Run npm run build to build the frontend.')}
})
server.listen(Number(process.env.PORT??3100),'127.0.0.1',()=>console.log('PEPL API + app: http://127.0.0.1:3100'))
