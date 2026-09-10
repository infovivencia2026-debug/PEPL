/** Botanical illustration drawn for PEPL's dashboard. */
export function AmbientSculpture() {
  return <div className="welcome-botanical" aria-hidden="true"><svg viewBox="0 0 200 220" fill="none">
    <defs><linearGradient id="leaf-front" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#d2e6c4"/><stop offset=".5" stopColor="#76b397"/><stop offset="1" stopColor="#245e50"/></linearGradient><linearGradient id="leaf-back" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#a9d0b6"/><stop offset="1" stopColor="#316e59"/></linearGradient></defs>
    <path d="M138 222 C137 166 143 124 143 37 M139 169 C114 146 96 134 69 122 M139 199 C162 171 176 158 199 144" stroke="#b7d6b9" strokeWidth="1.5" />
    <path d="M143 35 C97 85 108 110 140 137 C173 111 185 83 143 35Z" fill="url(#leaf-front)" stroke="#bdd6bb" strokeWidth=".7" />
    <path d="M63 116 C65 164 97 188 139 188 C127 143 105 119 63 116Z" fill="url(#leaf-back)" stroke="#aacdaf" strokeWidth=".7" />
    <path d="M140 213 C143 163 170 151 207 148 C199 194 180 210 140 213Z" fill="url(#leaf-front)" stroke="#aacdaf" strokeWidth=".7" />
    <path d="M143 37 L140 137 M64 117 L139 188 M141 213 L203 151 M143 68 L126 91 M143 87 L160 69 M142 110 L124 94 M82 139 L108 142 M106 163 L108 145 M163 188 L182 188" stroke="#dcE8ce" strokeOpacity=".45" strokeWidth=".8" />
  </svg></div>
}
