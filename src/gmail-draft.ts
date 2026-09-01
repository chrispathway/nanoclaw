import { gmail_v1 } from 'googleapis';

import { createGmailClient } from './gmail-auth.js';
import { logger } from './logger.js';

export interface CreateDraftRequest {
  /** Gmail thread id (preferred). Either this or messageId is required. */
  threadId?: string;
  /** Gmail message id; the thread is resolved from it. */
  messageId?: string;
  /** Plain-text reply body. Paragraphs separated by blank lines. */
  body: string;
  /** Override the recipient. Defaults to the Reply-To/From of the message replied to. */
  to?: string;
  /** Optional Cc recipients. */
  cc?: string;
  /** Override the subject. Defaults to a Re:-normalized thread subject. */
  subject?: string;
}

export interface CreateDraftResult {
  draftId: string;
  threadId: string;
  to: string;
  subject: string;
  inReplyTo: string;
}

const LIST_MARKER = /^\s*(?:[-*•+]\s|>|#{1,6}\s|\d+[.)]\s)/;

/**
 * Threshold above which a line is assumed to be a hard-wrapped fragment of a
 * paragraph rather than a deliberate standalone line. Machine wrapping happens
 * at 60-100 chars; greetings, sign-offs and headings are almost always shorter.
 */
const WRAPPED_LINE_MIN_LENGTH = 40;

/**
 * Remove hard line breaks from inside paragraphs so Gmail renders the body
 * full-width instead of as a narrow broken column.
 *
 * Blank lines (paragraph breaks) are preserved. Line breaks that carry meaning
 * are preserved too: list/quote items, the line after a "...:" lead-in, and
 * short standalone lines such as "Hi Anna," or "Best," / "Christian".
 */
export function normalizeEmailBody(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n\n');

  const rebuilt = paragraphs.map((paragraph) => {
    const lines = paragraph.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) return '';

    const out: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const prev = out[out.length - 1];

      const joinable =
        prev !== undefined &&
        prev.length >= WRAPPED_LINE_MIN_LENGTH &&
        !prev.endsWith(':') &&
        !LIST_MARKER.test(prev) &&
        !LIST_MARKER.test(line);

      if (joinable) {
        out[out.length - 1] = `${prev} ${line}`;
      } else {
        out.push(line);
      }
    }
    return out.join('\n');
  });

  return rebuilt
    .filter((p) => p.length > 0)
    .join('\n\n')
    .trim();
}

/** Strip any stack of Re:/RE:/Re[2]:/AW:/WG: prefixes and apply a single "Re: ". */
export function normalizeReplySubject(subject: string): string {
  const base = subject
    .replace(/^\s*(?:(?:re|aw|antw|wg|fwd?)(?:\[\d+\])?\s*:\s*)+/i, '')
    .trim();
  return base ? `Re: ${base}` : 'Re:';
}

/** RFC 2047 encoded-word for header values containing non-ASCII characters. */
function encodeHeaderText(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

/** Encode display names in an address list, leaving the addr-spec untouched. */
function encodeAddressList(value: string): string {
  return value
    .split(',')
    .map((entry) => {
      const trimmed = entry.trim();
      const match = trimmed.match(/^(.*?)\s*<([^>]+)>$/);
      if (!match) return trimmed;
      const name = match[1].replace(/^"|"$/g, '').trim();
      if (!name) return `<${match[2]}>`;
      return `${encodeHeaderText(name)} <${match[2]}>`;
    })
    .filter(Boolean)
    .join(', ');
}

function headerValue(
  message: gmail_v1.Schema$Message | undefined,
  name: string,
): string {
  const headers = message?.payload?.headers || [];
  return (
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ||
    ''
  );
}

function bareAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim().toLowerCase();
}

/** Wrap base64 at 76 chars so no line can exceed the SMTP line-length limit. */
function wrapBase64(value: string): string {
  return (value.match(/.{1,76}/g) || []).join('\r\n');
}

export function buildReplyMime(opts: {
  to: string;
  from: string;
  cc?: string;
  subject: string;
  inReplyTo: string;
  references: string;
  body: string;
}): string {
  const headers = [
    `To: ${encodeAddressList(opts.to)}`,
    `From: ${encodeAddressList(opts.from)}`,
    ...(opts.cc ? [`Cc: ${encodeAddressList(opts.cc)}`] : []),
    `Subject: ${encodeHeaderText(opts.subject)}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.references ? [`References: ${opts.references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];

  const encodedBody = wrapBase64(
    Buffer.from(opts.body, 'utf-8').toString('base64'),
  );
  return `${headers.join('\r\n')}\r\n\r\n${encodedBody}`;
}

function base64Url(value: string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const METADATA_HEADERS = [
  'Message-ID',
  'References',
  'In-Reply-To',
  'From',
  'Reply-To',
  'To',
  'Cc',
  'Subject',
  'Date',
];

/**
 * Create a Gmail draft that threads into an existing conversation exactly like
 * a manual Gmail reply: same threadId, plus In-Reply-To / References pointing
 * at the message being answered and a Re:-normalized subject.
 */
export async function createThreadedDraft(
  req: CreateDraftRequest,
): Promise<CreateDraftResult> {
  if (!req.threadId && !req.messageId) {
    throw new Error('Either threadId or messageId is required');
  }
  if (!req.body || !req.body.trim()) {
    throw new Error('Draft body is empty');
  }

  const client = createGmailClient();
  if (!client) {
    throw new Error(
      'Gmail credentials not found in ~/.gmail-mcp. Cannot create draft.',
    );
  }
  const { gmail } = client;

  const profile = await gmail.users.getProfile({ userId: 'me' });
  const selfEmail = (profile.data.emailAddress || '').toLowerCase();

  let threadId = req.threadId;
  if (!threadId) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: req.messageId!,
      format: 'metadata',
      metadataHeaders: METADATA_HEADERS,
    });
    threadId = msg.data.threadId || undefined;
    if (!threadId) {
      throw new Error(
        `Could not resolve a thread for message ${req.messageId}`,
      );
    }
  }

  const thread = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: METADATA_HEADERS,
  });

  const messages = thread.data.messages || [];
  if (messages.length === 0) {
    throw new Error(`Thread ${threadId} has no messages`);
  }

  // Reply to the newest message that is not one of ours; fall back to the newest.
  const target =
    [...messages]
      .reverse()
      .find((m) => bareAddress(headerValue(m, 'From')) !== selfEmail) ||
    messages[messages.length - 1];

  const targetMessageId = headerValue(target, 'Message-ID');
  const priorReferences = headerValue(target, 'References');
  const references = [priorReferences, targetMessageId]
    .filter(Boolean)
    .join(' ')
    .trim();

  const to =
    req.to || headerValue(target, 'Reply-To') || headerValue(target, 'From');
  if (!to) {
    throw new Error(`Could not determine a recipient for thread ${threadId}`);
  }

  const subject =
    req.subject ||
    normalizeReplySubject(
      headerValue(target, 'Subject') || headerValue(messages[0], 'Subject'),
    );

  const raw = base64Url(
    buildReplyMime({
      to,
      from: profile.data.emailAddress || '',
      cc: req.cc,
      subject,
      inReplyTo: targetMessageId,
      references,
      body: normalizeEmailBody(req.body),
    }),
  );

  const draft = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw, threadId } },
  });

  const draftId = draft.data.id || '';
  logger.info(
    { draftId, threadId, to, subject },
    'Gmail threaded draft created',
  );

  return { draftId, threadId, to, subject, inReplyTo: targetMessageId };
}
