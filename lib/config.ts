import { App } from 'aws-cdk-lib';

export interface AppConfig {
  readonly environment: string;
  readonly useSpot: boolean;
  readonly instanceType: string;
  readonly worldVolumeSizeGiB: number;
  readonly rootVolumeSizeGiB: number;
  readonly minecraftPort: number;
  readonly rconPort: number;
  readonly maxPlayers: number;
  readonly idleTimeoutSeconds: number;
  readonly idleCheckIntervalMinutes: number;
  readonly enableSsh: boolean;
  readonly sshCidr?: string;
  readonly mcEulaAccepted: boolean;
  readonly rconParameterName: string;
  readonly discordEnabled: boolean;
  readonly discordPublicKey?: string;
  readonly discordWebhookParameterName: string;
}

export function getConfig(app: App): AppConfig {
  const environment = stringContext(app, 'environment', '');
  const useSpot = boolContext(app, 'useSpot', false);
  const instanceType = stringContext(app, 'instanceType', 't3.medium');
  const worldVolumeSizeGiB = numberContext(app, 'worldVolumeSizeGiB', 10);
  const rootVolumeSizeGiB = numberContext(app, 'rootVolumeSizeGiB', 8);
  const minecraftPort = numberContext(app, 'minecraftPort', 25565);
  const rconPort = numberContext(app, 'rconPort', 25575);
  const maxPlayers = numberContext(app, 'maxPlayers', 3);
  const idleTimeoutSeconds = numberContext(app, 'idleTimeoutSeconds', 1500);
  const idleCheckIntervalMinutes = numberContext(
    app,
    'idleCheckIntervalMinutes',
    5,
  );
  const enableSsh = boolContext(app, 'enableSsh', false);
  const sshCidr = app.node.tryGetContext('sshCidr') as string | undefined;
  const mcEulaAccepted = boolContext(app, 'mcEulaAccepted', false);
  const rconParameterName = stringContext(
    app,
    'rconParameterName',
    `/minecraft-server-ondemand/${environment}/rcon-password`,
  );
  const discordEnabled = boolContext(app, 'discordEnabled', false);
  const discordPublicKey = app.node.tryGetContext('discordPublicKey') as string | undefined;
  const discordWebhookParameterName = stringContext(
    app,
    'discordWebhookParameterName',
    `/minecraft-server-ondemand/${environment}/discord-webhook-url`,
  );

  if (useSpot) {
    throw new Error('useSpot=true is not implemented yet; keep useSpot=false.');
  }
  if (worldVolumeSizeGiB <= 0 || rootVolumeSizeGiB <= 0) {
    throw new Error(
      'worldVolumeSizeGiB and rootVolumeSizeGiB must be positive.',
    );
  }
  if (maxPlayers <= 0) {
    throw new Error('maxPlayers must be positive.');
  }
  if (idleTimeoutSeconds <= 0 || idleCheckIntervalMinutes <= 0) {
    throw new Error(
      'idleTimeoutSeconds and idleCheckIntervalMinutes must be positive.',
    );
  }
  if (enableSsh && !sshCidr) {
    throw new Error('sshCidr is required in context when enableSsh=true.');
  }
  if (discordEnabled && !discordPublicKey) {
    throw new Error('discordPublicKey is required in context when discordEnabled=true.');
  }

  return {
    environment,
    useSpot,
    instanceType,
    worldVolumeSizeGiB,
    rootVolumeSizeGiB,
    minecraftPort,
    rconPort,
    maxPlayers,
    idleTimeoutSeconds,
    idleCheckIntervalMinutes,
    enableSsh,
    sshCidr,
    mcEulaAccepted,
    rconParameterName,
    discordEnabled,
    discordPublicKey,
    discordWebhookParameterName,
  };
}

function stringContext(app: App, key: string, fallback: string): string {
  const value = app.node.tryGetContext(key);
  return value === undefined ? fallback : String(value);
}

function numberContext(app: App, key: string, fallback: number): number {
  const value = app.node.tryGetContext(key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Context value "${key}" must be a number, got "${value}".`);
  }
  return parsed;
}

function boolContext(app: App, key: string, fallback: boolean): boolean {
  const value = app.node.tryGetContext(key);
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
}
