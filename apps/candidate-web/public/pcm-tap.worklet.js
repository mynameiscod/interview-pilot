// Realtime voice microphone tap (AudioWorklet). Copies each render quantum of
// the first input channel to the main thread, where it is resampled to 16 kHz
// PCM16 and cut into 100 ms frames (src/features/voice/pcm.ts). Served from
// the site itself because the Content-Security-Policy's script-src (which
// governs worklets) allows 'self' only.
class CbiPcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('cbi-pcm-tap', CbiPcmTap);
