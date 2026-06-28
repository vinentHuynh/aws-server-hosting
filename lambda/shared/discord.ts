import nacl from 'tweetnacl';

export function verifyDiscordSignature(
  signature: string | undefined,
  timestamp: string | undefined,
  rawBody: string,
  publicKeyHex: string,
): boolean {
  if (!signature || !timestamp || !publicKeyHex) return false;
  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + rawBody),
      Buffer.from(signature, 'hex'),
      Buffer.from(publicKeyHex, 'hex'),
    );
  } catch {
    return false;
  }
}

export async function postInteractionFollowup(
  applicationId: string,
  interactionToken: string,
  content: string,
): Promise<void> {
  const res = await fetch(
    `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    },
  );
  if (!res.ok) {
    console.error('discord followup failed', res.status, await res.text());
  }
}

export function deferredResponse(): { type: number } {
  return { type: 5 }; // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
}

export function messageResponse(content: string): { type: number; data: { content: string } } {
  return { type: 4, data: { content } }; // CHANNEL_MESSAGE_WITH_SOURCE
}
