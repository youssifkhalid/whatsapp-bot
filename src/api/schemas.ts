import { z } from 'zod';

export const groupIdSchema = z.string().regex(/^[\w.-]{1,64}@g\.us$/, 'invalid group id');
export const memberIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[\w.:+-]{1,64}@[\w.]{1,32}$/, 'invalid member id (expected e.g. 201000000000@c.us)');

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/^\*?\./, ''))
  .pipe(z.string().regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/, 'invalid domain'));

const word = z.string().trim().min(1).max(64);

export const loginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }).strict();
export const setupBody = z
  .object({ username: z.string().min(3).max(64), password: z.string().min(12).max(256), setupToken: z.string().min(1).max(256) })
  .strict();
export const passwordBody = z.object({ current: z.string().min(1).max(256), next: z.string().min(12).max(256) }).strict();
export const createUserBody = z
  .object({ username: z.string().min(3).max(64), password: z.string().min(12).max(256), role: z.enum(['admin', 'viewer']) })
  .strict();

export const groupPatch = z
  .object({
    enabled: z.boolean(),
    notifyGroup: z.boolean(),
    links: z
      .object({ enabled: z.boolean(), detectBareDomains: z.boolean(), allowedDomains: z.array(domain).max(200) })
      .partial()
      .strict(),
    profanity: z
      .object({ enabled: z.boolean(), customWords: z.array(word).max(500), allowWords: z.array(word).max(500) })
      .partial()
      .strict(),
  })
  .partial()
  .strict();

export const exclusionBody = z.object({ memberId: memberIdSchema }).strict();

export const settingsPatch = z
  .object({
    testMode: z.boolean(),
    ownerIds: z.array(memberIdSchema).max(50),
    /** Required when turning test mode OFF, so real removals cannot be enabled by accident. */
    confirmDisableTestMode: z.literal(true),
  })
  .partial()
  .strict();

const ts = z
  .string()
  .max(40)
  .transform((s, ctx) => {
    const n = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: 'custom', message: 'invalid timestamp' });
      return z.NEVER;
    }
    return n;
  });

export const eventsQuery = z
  .object({
    groupId: groupIdSchema.optional(),
    senderId: z.string().max(80).optional(),
    type: z.enum(['link', 'profanity']).optional(),
    status: z
      .enum(['completed', 'partial', 'failed', 'simulated', 'skipped_protected', 'skipped_check_failed', 'duplicate'])
      .optional(),
    q: z.string().max(100).optional(),
    from: ts.optional(),
    to: ts.optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
  })
  .strict();

export const statsQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(7) }).strict();
export const pageQuery = z
  .object({ page: z.coerce.number().int().min(1).max(100_000).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();
