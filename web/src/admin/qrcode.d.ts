declare module 'qrcode' {
  const QRCode: {
    toCanvas(canvas: HTMLCanvasElement, text: string, options?: Record<string, unknown>): Promise<void>
    toString(text: string, options?: Record<string, unknown>): Promise<string>
  }
  export default QRCode
}
