import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { logger } from './logger.js';

export const GMAIL_CRED_DIR = path.join(os.homedir(), '.gmail-mcp');
export const GMAIL_KEYS_PATH = path.join(GMAIL_CRED_DIR, 'gcp-oauth.keys.json');
export const GMAIL_TOKENS_PATH = path.join(GMAIL_CRED_DIR, 'credentials.json');

export function hasGmailCredentials(): boolean {
  return fs.existsSync(GMAIL_KEYS_PATH) && fs.existsSync(GMAIL_TOKENS_PATH);
}

/**
 * Build an authenticated Gmail client from the credentials in ~/.gmail-mcp.
 * Returns null when credentials are missing.
 *
 * Refreshed tokens are written back to credentials.json so the channel and any
 * other consumer stay in sync on the same token file.
 */
export function createGmailClient(): {
  gmail: gmail_v1.Gmail;
  oauth2Client: OAuth2Client;
} | null {
  if (!hasGmailCredentials()) return null;

  const keys = JSON.parse(fs.readFileSync(GMAIL_KEYS_PATH, 'utf-8'));
  const tokens = JSON.parse(fs.readFileSync(GMAIL_TOKENS_PATH, 'utf-8'));

  const clientConfig = keys.installed || keys.web || keys;
  const { client_id, client_secret, redirect_uris } = clientConfig;
  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0],
  );
  oauth2Client.setCredentials(tokens);

  oauth2Client.on('tokens', (newTokens) => {
    try {
      const current = JSON.parse(fs.readFileSync(GMAIL_TOKENS_PATH, 'utf-8'));
      Object.assign(current, newTokens);
      fs.writeFileSync(GMAIL_TOKENS_PATH, JSON.stringify(current, null, 2));
      logger.debug('Gmail OAuth tokens refreshed');
    } catch (err) {
      logger.warn({ err }, 'Failed to persist refreshed Gmail tokens');
    }
  });

  return {
    gmail: google.gmail({ version: 'v1', auth: oauth2Client }),
    oauth2Client,
  };
}
