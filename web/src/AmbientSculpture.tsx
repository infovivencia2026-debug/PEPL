/** Quiet contour artwork, deliberately distinct from the PEPL brand mark. */
export function AmbientSculpture() {
  return <div className="welcome-contours" aria-hidden="true">
    <svg viewBox="0 0 240 260" fill="none">
      <defs><linearGradient id="contour-ink" x1="20" y1="20" x2="220" y2="260" gradientUnits="userSpaceOnUse"><stop stopColor="#cee2c6" stopOpacity=".6"/><stop offset="1" stopColor="#cee2c6" stopOpacity="0"/></linearGradient></defs>
      {[0, 1, 2, 3, 4, 5, 6].map(index => <path key={index} d={`M ${20 + index * 17} 270 C ${-40 + index * 17} 170, ${180 + index * 10} 160, ${80 + index * 20} -20`} stroke="url(#contour-ink)" strokeWidth="1" />)}
      <circle cx="185" cy="61" r="5" fill="#d8c29b" fillOpacity=".7" />
    </svg>
  </div>
}
