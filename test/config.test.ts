import { App } from 'aws-cdk-lib';
import { getConfig } from '../lib/config';

function appWithContext(context: Record<string, unknown>): App {
  return new App({ context });
}

describe('getConfig', () => {
  test('applies defaults when no context is supplied', () => {
    const config = getConfig(appWithContext({}));
    expect(config.instanceType).toBe('t3.medium');
    expect(config.useSpot).toBe(false);
    expect(config.maxPlayers).toBe(3);
    expect(config.idleTimeoutSeconds).toBe(1500);
    expect(config.enableSsh).toBe(false);
  });

  test('rejects useSpot=true', () => {
    expect(() => getConfig(appWithContext({ useSpot: true }))).toThrow(/useSpot/);
  });

  test('rejects non-positive volume sizes', () => {
    expect(() => getConfig(appWithContext({ worldVolumeSizeGiB: 0 }))).toThrow(/positive/);
  });

  test('rejects enableSsh=true without sshCidr', () => {
    expect(() => getConfig(appWithContext({ enableSsh: true }))).toThrow(/sshCidr/);
  });

  test('accepts enableSsh=true with sshCidr', () => {
    const config = getConfig(appWithContext({ enableSsh: true, sshCidr: '1.2.3.4/32' }));
    expect(config.enableSsh).toBe(true);
    expect(config.sshCidr).toBe('1.2.3.4/32');
  });
});
