import { CreateDesignPromptVersionBody, type DesignPromptContent } from '@cbi/shared-types';
import type { Model } from 'mongoose';
import { DesignPromptModel } from '../models/design.js';
import { ensureVersionedSeed, type VersionedDoc } from './versioned.js';

interface SeedDesignPrompt {
  key: string;
  /** Bumped when the content changes (see ensureVersionedSeed). */
  revision: number;
  content: DesignPromptContent;
}

/** Original system design prompts for the design bank. Admins add more in the console. */
const PROMPTS: SeedDesignPrompt[] = [
  {
    key: 'short-link-service',
    revision: 1,
    content: {
      title: 'Short links for a marketing team',
      prompt:
        'A marketing team shares long campaign URLs in SMS messages, where every character costs money. Design a service that turns a long URL into a short link (for example `go.example/Ab3xZ`), redirects anyone who opens the short link, and reports how many times each link was opened per day.\n\nStart with about 5 million new links a month and 200 million redirects a month, mostly in the first days after a campaign is sent.',
      difficulty: 'EASY',
      tags: ['storage', 'caching', 'hashing'],
      focusAreas: [
        'How short codes are generated without collisions',
        'Keeping redirects fast during a campaign spike',
        'Counting opens without slowing redirects down',
      ],
      considerations: [
        'Clarifies read-heavy traffic (redirects far outnumber creations) and estimates peak rates',
        'Code generation: counter with base-62 encoding, or random codes with a collision check; code length versus link space',
        'Simple API: create (with optional custom alias and expiry) and redirect (301 versus 302 and why it matters for counting)',
        'Key-value storage of code to URL; data size estimate',
        'Caching hot links close to users; handling expired or deleted links',
        'Counting opens asynchronously (log or queue, then aggregate) rather than writing on every redirect',
        'Abuse: spam or malicious URLs, rate limits on creation',
      ],
    },
  },
  {
    key: 'exam-results-portal',
    revision: 1,
    content: {
      title: 'Exam results day',
      prompt:
        'A state education board publishes the results of 1.5 million students at 10:00 on one morning. Students look up their marks with their roll number and date of birth, and schools download results for all their students. Last year the old website went down within minutes.\n\nDesign the results system so it stays up at 10:00 and results are correct and private.',
      difficulty: 'EASY',
      tags: ['caching', 'scaling', 'read-heavy'],
      focusAreas: [
        'The traffic pattern around 10:00',
        'Preparing results before they go live',
        'Keeping each student’s marks private',
      ],
      considerations: [
        'Estimates the spike (many requests per second in the first minutes) versus normal load',
        'Results are read-only once published: precompute and publish as static or cached data, possibly behind a CDN',
        'Lookup keyed by roll number plus a second factor; protection against scraping other students’ results (rate limits, captcha)',
        'Warm-up and load testing before the day; a switch that makes results visible at 10:00 everywhere at once',
        'School bulk downloads handled separately (pre-generated files, authenticated) so they do not compete with students',
        'Graceful degradation: a waiting page or queue instead of errors; SMS fallback',
        'Correcting a published result: versioning and cache invalidation',
      ],
    },
  },
  {
    key: 'notification-service',
    revision: 1,
    content: {
      title: 'Notifications for every channel',
      prompt:
        'Several product teams need to send notifications to users: order updates, OTPs, reminders and promotions, over SMS, email, push and WhatsApp. Design one notification service that all teams call.\n\nUsers can choose which kinds of messages they get on which channel. OTPs must arrive within seconds; promotions can wait. The company sends about 50 million notifications a day.',
      difficulty: 'MEDIUM',
      tags: ['queues', 'reliability', 'third-party-apis'],
      focusAreas: [
        'Priorities: OTPs versus promotions',
        'User preferences and quiet hours',
        'What happens when an SMS or email provider is down',
      ],
      considerations: [
        'API for teams: template id, user, variables, priority and an idempotency key',
        'Separate queues or priorities so OTPs are never stuck behind bulk promotions',
        'Preference and consent checks (opt-outs, quiet hours) before sending',
        'Provider adapters with retries, backoff and failover to a second provider',
        'Delivery status tracking via provider callbacks; per-user rate limits to avoid spamming',
        'Templates with localisation; storing what was sent for audit',
        'Scale estimate and horizontal scaling of stateless workers',
      ],
    },
  },
  {
    key: 'api-rate-limiter',
    revision: 1,
    content: {
      title: 'Rate limiting a public API',
      prompt:
        'A company exposes a public REST API to partner developers. Each partner has a plan: for example, 100 requests per second and 1 million requests per day. The API runs on 30 servers behind a load balancer.\n\nDesign the rate limiting so every partner stays within their plan across all servers, without adding noticeable latency to requests.',
      difficulty: 'MEDIUM',
      tags: ['distributed-systems', 'caching', 'algorithms'],
      focusAreas: [
        'The limiting algorithm and its trade-offs',
        'Sharing counts across 30 servers',
        'What happens when the counter store is slow or down',
      ],
      considerations: [
        'Compares fixed window, sliding window and token bucket; bursts at window edges',
        'Central fast store (for example Redis) with atomic operations or scripts; per-partner keys',
        'Local approximations or batching to cut latency, and the accuracy they give up',
        'Response behaviour: 429 status, retry-after and remaining-quota headers',
        'Fail-open versus fail-closed when the store is unavailable, and why',
        'Plan configuration changes without restarts; different limits per endpoint',
        'Monitoring partners close to their limits',
      ],
    },
  },
  {
    key: 'food-order-tracking',
    revision: 1,
    content: {
      title: 'Live tracking of food orders',
      prompt:
        'A food delivery app shows customers the live status of their order (accepted, being prepared, picked up) and the delivery partner’s position on a map until the food arrives. Delivery partners’ phones send their location every few seconds.\n\nDesign the tracking part for a city with 200 000 orders at dinner time and 30 000 partners on the road.',
      difficulty: 'MEDIUM',
      tags: ['real-time', 'geo', 'streaming'],
      focusAreas: [
        'Getting location updates from phones to customers',
        'Phones with poor networks',
        'How long location history is kept',
      ],
      considerations: [
        'Estimates the update rate (partners times updates per minute) and fan-out to watching customers',
        'Ingestion path for location updates (lightweight endpoint or socket, then a stream or queue)',
        'Latest position in a fast store keyed by partner; order status as a state machine',
        'Pushing updates to customers (WebSockets, server-sent events or polling) and the trade-offs',
        'Handling gaps and out-of-order updates from weak networks; smoothing on the map',
        'Privacy: customers see a partner’s position only during their active delivery; retention limits',
        'Estimated arrival time as a separate service',
      ],
    },
  },
  {
    key: 'wallet-ledger',
    revision: 1,
    content: {
      title: 'A wallet with a trustworthy ledger',
      prompt:
        'A fintech app lets users keep money in a wallet, add money from a bank account, pay merchants and send money to friends. Users must never lose money or see it twice, even when a request is retried or a server crashes halfway through a payment.\n\nDesign the wallet and its ledger for 10 million users and a peak of 3 000 payments per second.',
      difficulty: 'HARD',
      tags: ['fintech', 'consistency', 'databases'],
      focusAreas: [
        'How balances and payments are recorded',
        'Retries and duplicate requests',
        'Reconciling with banks',
      ],
      considerations: [
        'Double-entry, append-only ledger as the source of truth; balances derived from or checked against it',
        'Idempotency keys on every money-moving request; exactly-once effect despite retries',
        'Transactions or careful locking so a transfer debits and credits atomically; preventing negative balances under concurrency',
        'Asynchronous steps with bank or payment networks: pending states, timeouts and a state machine per payment',
        'Daily reconciliation against bank statements; handling mismatches',
        'Audit trail, limits and fraud checks; regulatory retention',
        'Scaling writes (partitioning by account) and the cross-partition transfer problem',
      ],
    },
  },
  {
    key: 'cab-dispatch',
    revision: 1,
    content: {
      title: 'Matching riders with nearby drivers',
      prompt:
        'A ride-hailing app matches riders who request a trip with a nearby available driver. Drivers send their location every 4 seconds; a rider should get a driver within a few seconds of asking, and a driver must never be given two trips at once.\n\nDesign the dispatch system for a metro area with 100 000 active drivers and 5 000 ride requests per minute at peak.',
      difficulty: 'HARD',
      tags: ['geo', 'real-time', 'concurrency'],
      focusAreas: [
        'Finding available drivers near a pickup point',
        'Offering a trip to a driver and handling declines',
        'Never assigning one driver to two riders',
      ],
      considerations: [
        'Spatial indexing of driver locations (geohash, grid cells or a quadtree) in memory, updated frequently',
        'Search outward from the pickup cell; ranking by distance or estimated time, not just straight-line distance',
        'Offer flow with timeouts; retry with the next driver on decline or no response',
        'Atomic driver reservation (compare-and-set or lock with expiry) to prevent double assignment',
        'Partitioning by region and handling the edges between regions',
        'Surge situations and fairness between drivers',
        'What happens when the dispatch service restarts: rebuilding state from the location stream',
      ],
    },
  },
  {
    key: 'group-chat',
    revision: 1,
    content: {
      title: 'Group chat with read receipts',
      prompt:
        'Design the messaging backend for a chat app used by teams: one-to-one chats and groups of up to 500 people, delivered and read receipts, and messages that arrive in order on every device a person uses, including after being offline for a day.\n\nPlan for 20 million daily users sending 1 billion messages a day.',
      difficulty: 'HARD',
      tags: ['real-time', 'messaging', 'storage'],
      focusAreas: [
        'Delivering messages to online and offline devices',
        'Ordering within a conversation',
        'Receipts in large groups',
      ],
      considerations: [
        'Persistent connections through gateway servers; a registry of which gateway holds which device',
        'Store-then-deliver: messages are written durably before delivery; per-conversation sequence numbers for ordering',
        'Offline sync: each device fetches messages after its last sequence number',
        'Fan-out for groups (on write versus on read) and its cost for 500-member groups',
        'Receipts aggregated for large groups rather than one event per member per message',
        'Storage partitioned by conversation; retention and media stored separately',
        'Push notifications for offline devices; end-to-end encryption trade-offs mentioned',
      ],
    },
  },
];

/** The seeded design prompts (validated like an admin's new version). */
export const SEED_DESIGN_PROMPTS: SeedDesignPrompt[] = PROMPTS.map((p) => ({
  ...p,
  content: CreateDesignPromptVersionBody.parse({
    key: p.key,
    content: p.content,
    reason: 'Seeded design prompt',
  }).content,
}));

/**
 * Idempotent, versioned seed of the design bank (the same rules as the
 * problem bank: an admin's version is never replaced). Returns the versions
 * created.
 */
export function ensureDesignPromptBank(): Promise<number> {
  return ensureVersionedSeed(
    DesignPromptModel as unknown as Model<VersionedDoc>,
    SEED_DESIGN_PROMPTS,
  );
}
