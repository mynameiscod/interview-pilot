import {
  DeviceCheckBody,
  SwitchModeBody,
  TranscribeFields,
  VOICE_LIMITS,
  VoiceConsentBody,
} from '@cbi/shared-types';
import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import type { Container } from '../../container.js';
import { AppError } from '../../lib/errors.js';
import { clientContext } from '../../lib/request-context.js';
import { authenticate, requireAuth } from '../../middleware/authenticate.js';

const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/** One recorded answer in the `audio` field, held in memory and sent on to the speech model. */
const audioUpload: RequestHandler = (() => {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: VOICE_LIMITS.maxAudioBytes,
      files: 1,
      fields: 5,
      fieldSize: 256,
      parts: 7,
    },
  }).single('audio');
  return (req, res, next) => {
    handler(req, res, (err: unknown) => {
      if (!err) {
        if (!req.file)
          return next(AppError.validation('Attach the recording in the "audio" field.'));
        return next();
      }
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(413, 'PAYLOAD_TOO_LARGE', 'The recording is too long.'));
      }
      return next(AppError.validation('Upload one recording in the "audio" field.'));
    });
  };
})();

/** `/voice`: speech service status for the device check. */
export function voiceRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('candidate', c), noStore);
  router.get('/health', async (_req, res) => {
    res.json({ data: await c.voice.health() });
  });
  return router;
}

/** Voice endpoints under `/interviews/:id`. */
export function voiceInterviewRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('candidate', c), noStore);

  router.post('/:id/device-check', async (req, res) => {
    const body = DeviceCheckBody.parse(req.body);
    res.json({
      data: await c.voice.recordDeviceCheck(requireAuth(req).userId, String(req.params.id), body),
    });
  });

  router.post('/:id/voice-consent', async (req, res) => {
    const body = VoiceConsentBody.parse(req.body);
    res.json({
      data: await c.voice.recordConsent(
        requireAuth(req).userId,
        String(req.params.id),
        body,
        clientContext(req),
      ),
    });
  });

  router.post('/:id/voice/transcribe', c.limiters.voice, audioUpload, async (req, res) => {
    const fields = TranscribeFields.parse(req.body);
    res.json({
      data: await c.voice.transcribe(
        requireAuth(req).userId,
        String(req.params.id),
        fields,
        req.file!.buffer,
      ),
    });
  });

  router.get('/:id/questions/:questionId/audio', c.limiters.voice, async (req, res) => {
    const { audio, mimeType } = await c.voice.questionAudio(
      requireAuth(req).userId,
      String(req.params.id),
      String(req.params.questionId),
    );
    res.set({
      'Content-Type': mimeType,
      'Content-Length': String(audio.length),
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(audio);
  });

  router.post('/:id/mode', async (req, res) => {
    const body = SwitchModeBody.parse(req.body);
    res.json({
      data: await c.voice.switchMode(
        requireAuth(req).userId,
        String(req.params.id),
        body,
        clientContext(req),
      ),
    });
  });

  return router;
}
