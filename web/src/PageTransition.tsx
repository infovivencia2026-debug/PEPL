import { useEffect, useRef, type ReactNode } from 'react'

// Original three-tile Lottie animation; no external asset requests.
const animationData = {
  v: '5.9.0', fr: 60, ip: 0, op: 48, w: 72, h: 32, nm: 'PEPL workspace switch', ddd: 0, assets: [],
  layers: [0, 1, 2].map(index => ({
    ddd: 0, ind: index + 1, ty: 4, nm: `Tile ${index + 1}`, sr: 1, ip: 0, op: 48, st: 0, bm: 0,
    ks: {
      o: { a: 1, k: [{ t: 0, s: [0], e: [100], o: { x: .3, y: 0 }, i: { x: .7, y: 1 } }, { t: 8 + index * 4, s: [100], e: [0], o: { x: .3, y: 0 }, i: { x: .7, y: 1 } }, { t: 48, s: [0] }] },
      r: { a: 0, k: 0 }, p: { a: 0, k: [16 + index * 20, 16, 0] }, a: { a: 0, k: [0, 0, 0] },
      s: { a: 1, k: [{ t: index * 4, s: [35, 35, 100], e: [110, 110, 100], o: { x: .16, y: 1 }, i: { x: .3, y: 1 } }, { t: 20 + index * 4, s: [110, 110, 100], e: [75, 75, 100], o: { x: .3, y: 0 }, i: { x: .7, y: 1 } }, { t: 48, s: [75, 75, 100] }] },
    },
    shapes: [{ ty: 'rc', d: 1, s: { a: 0, k: [13, 13] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 4 }, nm: 'Rounded tile' }, { ty: 'fl', c: { a: 0, k: index === 2 ? [.91, .46, .36, 1] : index === 1 ? [.52, .68, .58, 1] : [.12, .34, .29, 1] }, o: { a: 0, k: 100 }, r: 1, bm: 0, nm: 'Fill' }],
  })),
}

export function PageTransition({ route, children }: { route: string; children: ReactNode }) {
  const accent = useRef<HTMLDivElement>(null)
  const sweep = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)')
    if (preference.matches) return
    let cancelled = false
    let cleanup = () => {}
    const stop = () => cleanup()
    preference.addEventListener('change', stop)
    void import('three').then(T => {
      if (cancelled || !sweep.current || preference.matches) return
      const element = sweep.current
      let renderer: InstanceType<typeof T.WebGLRenderer>
      try { renderer = new T.WebGLRenderer({ alpha: true, powerPreference: 'low-power' }) } catch { return }
      renderer.setPixelRatio(1)
      renderer.setSize(element.clientWidth, element.clientHeight)
      const scene = new T.Scene()
      const camera = new T.Camera()
      const geometry = new T.PlaneGeometry(2, 2)
      const material = new T.ShaderMaterial({
        transparent: true, depthTest: false, uniforms: { progress: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position,1.0);}',
        fragmentShader: 'varying vec2 vUv; uniform float progress; void main(){float x=vUv.x+vUv.y*.12;float band=exp(-pow((x-progress*1.5+.2)*7.,2.));float fade=sin(progress*3.14159);gl_FragColor=vec4(.42,.68,.53,band*fade*.17*vUv.y);}',
      })
      scene.add(new T.Mesh(geometry, material))
      element.appendChild(renderer.domElement)
      let start = -1
      let disposed = false
      cleanup = () => {
        if (disposed) return
        disposed = true
        renderer.setAnimationLoop(null); geometry.dispose(); material.dispose(); renderer.dispose(); renderer.domElement.remove()
      }
      renderer.setAnimationLoop(time => {
        if (start < 0) start = time
        material.uniforms.progress.value = Math.min((time - start) / 520, 1)
        if (material.uniforms.progress.value >= 1) { cleanup(); return }
        renderer.render(scene, camera)
      })
    }).catch(() => {})
    return () => { cancelled = true; cleanup(); preference.removeEventListener('change', stop) }
  }, [route])
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)')
    if (preference.matches) return
    let cancelled = false
    let destroy = () => {}
    const stop = () => destroy()
    preference.addEventListener('change', stop)
    void import('lottie-web/build/player/lottie_light').then(({ default: lottie }) => {
      if (cancelled || !accent.current || preference.matches) return
      const animation = lottie.loadAnimation({ container: accent.current, renderer: 'svg', loop: false, autoplay: true, animationData: structuredClone(animationData) })
      destroy = () => animation.destroy()
    }).catch(() => { /* Page transition remains available without the decorative accent. */ })
    return () => { cancelled = true; destroy(); preference.removeEventListener('change', stop) }
  }, [route])
  return <div className="route-transition"><div ref={sweep} className="route-sweep" aria-hidden="true" /><div ref={accent} className="route-accent" aria-hidden="true" /><div key={route} className="route-content" role="region" tabIndex={0} aria-label="Page content">{children}</div></div>
}
