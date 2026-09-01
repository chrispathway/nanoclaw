import { describe, it, expect } from 'vitest';

import {
  buildReplyMime,
  normalizeEmailBody,
  normalizeReplySubject,
} from './gmail-draft.js';

describe('normalizeEmailBody', () => {
  it('joins hard-wrapped lines inside a paragraph', () => {
    const input = [
      'Thanks for reaching out about a collaboration, I had a look at',
      'the product and it fits my audience well. Here is how I usually',
      'structure these.',
    ].join('\n');

    expect(normalizeEmailBody(input)).toBe(
      'Thanks for reaching out about a collaboration, I had a look at the product and it fits my audience well. Here is how I usually structure these.',
    );
  });

  it('preserves blank-line paragraph breaks', () => {
    const input =
      'First paragraph that is long enough to be treated as wrapped text.\nSecond half of it.\n\nSecond paragraph.';
    expect(normalizeEmailBody(input)).toBe(
      'First paragraph that is long enough to be treated as wrapped text. Second half of it.\n\nSecond paragraph.',
    );
  });

  it('collapses three or more newlines into a single paragraph break', () => {
    expect(normalizeEmailBody('One.\n\n\n\nTwo.')).toBe('One.\n\nTwo.');
  });

  it('keeps greetings and sign-offs on their own lines', () => {
    const input = 'Hi Anna,\n\nSounds good.\n\nBest,\nChristian';
    expect(normalizeEmailBody(input)).toBe(
      'Hi Anna,\n\nSounds good.\n\nBest,\nChristian',
    );
  });

  it('keeps list items on their own lines', () => {
    const input = [
      'The breakdown for this package, so you can see where the number comes from:',
      '- 1 Instagram reel: $9,000',
      '- 3 month ad rights: $4,000',
    ].join('\n');

    expect(normalizeEmailBody(input)).toBe(input);
  });

  it('keeps numbered list items on their own lines', () => {
    const input = '1. First option here\n2. Second option here';
    expect(normalizeEmailBody(input)).toBe(input);
  });

  it('normalizes CRLF and trailing whitespace', () => {
    expect(normalizeEmailBody('One.  \r\n\r\nTwo.  ')).toBe('One.\n\nTwo.');
  });

  it('leaves an already well-formed body untouched', () => {
    const input =
      'Thanks for the note, happy to take a look at this and get back to you shortly.\n\nBest,\nChristian';
    expect(normalizeEmailBody(input)).toBe(input);
  });
});

describe('normalizeReplySubject', () => {
  it('adds Re: to a plain subject', () => {
    expect(normalizeReplySubject('Collaboration')).toBe('Re: Collaboration');
  });

  it('does not stack Re: prefixes', () => {
    expect(normalizeReplySubject('Re: Collaboration')).toBe(
      'Re: Collaboration',
    );
    expect(normalizeReplySubject('RE: RE: Collaboration')).toBe(
      'Re: Collaboration',
    );
    expect(normalizeReplySubject('Re[2]: Collaboration')).toBe(
      'Re: Collaboration',
    );
  });

  it('strips localized and forward prefixes', () => {
    expect(normalizeReplySubject('AW: Angebot')).toBe('Re: Angebot');
    expect(normalizeReplySubject('Fwd: Angebot')).toBe('Re: Angebot');
  });

  it('handles an empty subject', () => {
    expect(normalizeReplySubject('')).toBe('Re:');
  });
});

describe('buildReplyMime', () => {
  const base = {
    to: 'Anna <anna@brand.com>',
    from: 'me@example.com',
    subject: 'Re: Collaboration',
    inReplyTo: '<abc123@mail.brand.com>',
    references: '<root@mail.brand.com> <abc123@mail.brand.com>',
    body: 'Hello there.',
  };

  it('writes the threading headers', () => {
    const mime = buildReplyMime(base);
    expect(mime).toContain('In-Reply-To: <abc123@mail.brand.com>');
    expect(mime).toContain(
      'References: <root@mail.brand.com> <abc123@mail.brand.com>',
    );
    expect(mime).toContain('To: Anna <anna@brand.com>');
    expect(mime).toContain('Subject: Re: Collaboration');
  });

  it('base64-encodes the body so no line exceeds the SMTP limit', () => {
    const mime = buildReplyMime({ ...base, body: 'x'.repeat(5000) });
    expect(mime).toContain('Content-Transfer-Encoding: base64');

    const [headers, body] = mime.split('\r\n\r\n');
    expect(headers).toBeTruthy();
    for (const line of body.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString()).toBe(
      'x'.repeat(5000),
    );
  });

  it('RFC 2047 encodes non-ASCII subjects and display names', () => {
    const mime = buildReplyMime({
      ...base,
      to: 'Jürgen Müller <j@brand.de>',
      subject: 'Re: Grüße',
    });
    expect(mime).toContain('=?UTF-8?B?');
    expect(mime).toContain('<j@brand.de>');
    expect(mime).not.toContain('Subject: Re: Grüße');
  });

  it('omits Cc when not provided', () => {
    expect(buildReplyMime(base)).not.toContain('Cc:');
    expect(buildReplyMime({ ...base, cc: 'x@y.com' })).toContain('Cc: x@y.com');
  });
});
