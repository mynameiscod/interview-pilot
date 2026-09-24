import { vi } from 'vitest';

/**
 * Minimal stand-ins for the browser media APIs jsdom lacks (getUserMedia,
 * MediaRecorder, AudioContext, object URLs, HTMLMediaElement.play) so voice
 * and video pages can be tested. `level` sets the microphone input level
 * (0–1) the analyser reports. A request with `video` gets a camera track
 * (640 px wide unless `videoWidth` says otherwise) and a microphone track.
 * Call `uninstall` after each test.
 */
export function installFakeMedia(
  opts: {
    micError?: Error;
    /** Makes camera requests (getUserMedia with video) fail. */
    cameraError?: Error;
    /** Width the camera track reports (0: no picture). */
    videoWidth?: number;
    level?: number;
    mimeTypes?: string[];
    /** Makes HTMLMediaElement.play() reject (autoplay blocked). */
    playRejects?: boolean;
  } = {},
) {
  const supported = opts.mimeTypes ?? [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'video/webm;codecs=vp9,opus',
  ];
  const media = {
    level: opts.level ?? 0.5,
    tracks: [] as FakeTrack[],
    streams: [] as FakeStream[],
    recorders: [] as FakeMediaRecorder[],
    contexts: [] as FakeAudioContext[],
    played: [] as HTMLMediaElement[],
    objectUrls: [] as string[],
    revoked: [] as string[],
  };

  class FakeTrack extends EventTarget {
    stopped = false;
    readyState: 'live' | 'ended' = 'live';
    constructor(readonly kind: 'audio' | 'video') {
      super();
    }
    stop() {
      this.stopped = true;
      this.readyState = 'ended';
    }
    getSettings() {
      return this.kind === 'video' ? { width: opts.videoWidth ?? 640, height: 480 } : {};
    }
    /** The browser ends the track by itself (device unplugged, permission revoked). */
    end() {
      this.readyState = 'ended';
      this.dispatchEvent(new Event('ended'));
    }
  }

  class FakeStream {
    private readonly tracks: FakeTrack[];
    constructor(video: boolean) {
      this.tracks = video
        ? [new FakeTrack('video'), new FakeTrack('audio')]
        : [new FakeTrack('audio')];
      media.tracks.push(...this.tracks);
      media.streams.push(this);
    }
    getTracks() {
      return this.tracks;
    }
    getVideoTracks() {
      return this.tracks.filter((t) => t.kind === 'video');
    }
    getAudioTracks() {
      return this.tracks.filter((t) => t.kind === 'audio');
    }
  }

  class FakeMediaRecorder {
    static isTypeSupported = (type: string) => supported.includes(type);
    state: 'inactive' | 'recording' = 'inactive';
    mimeType: string;
    timeslice: number | undefined;
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(
      readonly stream: FakeStream,
      options: { mimeType?: string } = {},
    ) {
      this.mimeType = options.mimeType ?? '';
      media.recorders.push(this);
    }
    start(timeslice?: number) {
      this.state = 'recording';
      this.timeslice = timeslice;
    }
    stop() {
      this.state = 'inactive';
      const last = this.mimeType.startsWith('video') ? 'last-segment' : 'spoken-answer';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob([last], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
    /** A timeslice elapsed: hands over a chunk as the browser would. */
    emit(data: string) {
      this.ondataavailable?.({ data: new Blob([data], { type: this.mimeType }) });
    }
  }

  class FakeAudioContext {
    currentTime = 0;
    closed = false;
    destination = {};
    constructor() {
      media.contexts.push(this);
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createAnalyser() {
      return {
        fftSize: 1024,
        getByteTimeDomainData(buffer: Uint8Array) {
          // A square wave whose RMS gives the configured level (see createLevelMeter).
          const amplitude = Math.round((media.level * 128) / 3);
          buffer.forEach((_, i) => (buffer[i] = 128 + (i % 2 === 0 ? amplitude : -amplitude)));
        },
      };
    }
    createOscillator() {
      const osc = {
        type: 'sine',
        frequency: { value: 0 },
        onended: null as null | (() => void),
        connect() {},
        start() {},
        stop() {
          queueMicrotask(() => osc.onended?.());
        },
      };
      return osc;
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} };
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
  }

  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints = {}) => {
    const video = Boolean(constraints.video);
    if (video && opts.cameraError) throw opts.cameraError;
    if (opts.micError) throw opts.micError;
    return new FakeStream(video);
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);

  const originalUrls = {
    create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
    revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
  };
  let urls = 0;
  const createObjectURL = vi.fn(() => {
    const url = `blob:test/${++urls}`;
    media.objectUrls.push(url);
    return url;
  });
  const revokeObjectURL = vi.fn((url: string) => void media.revoked.push(url));
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });

  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    media.played.push(this);
    return opts.playRejects
      ? Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'))
      : Promise.resolve();
  });
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

  return {
    media,
    getUserMedia,
    play,
    pause,
    uninstall() {
      vi.unstubAllGlobals();
      play.mockRestore();
      pause.mockRestore();
      delete (navigator as { mediaDevices?: unknown }).mediaDevices;
      delete (URL as { createObjectURL?: unknown }).createObjectURL;
      delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
      if (originalUrls.create) Object.defineProperty(URL, 'createObjectURL', originalUrls.create);
      if (originalUrls.revoke) Object.defineProperty(URL, 'revokeObjectURL', originalUrls.revoke);
    },
  };
}

export type FakeMedia = ReturnType<typeof installFakeMedia>;
