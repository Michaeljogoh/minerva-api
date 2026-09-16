import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

interface StoredScreenshot {
  id: string;
  clientId: string;
  buffer: Buffer;
  createdAt: Date;
}

const MAX_SCREENSHOTS_PER_CLIENT = 40;
const MAX_SCREENSHOTS_TOTAL = 200;

/**
 * Session-scoped JPEG screenshots (quality 60 per PRD §10.5).
 * In-memory for MVP; swap to disk/S3 later if needed.
 */
@Injectable()
export class ScreenshotStore {
  private readonly shots = new Map<string, StoredScreenshot>();

  save(clientId: string, jpegBuffer: Buffer): string {
    this.evictIfNeeded(clientId);
    const id = randomUUID();
    this.shots.set(id, {
      id,
      clientId,
      buffer: jpegBuffer,
      createdAt: new Date(),
    });
    return id;
  }

  private evictIfNeeded(clientId: string): void {
    while (this.shots.size >= MAX_SCREENSHOTS_TOTAL) {
      const oldest = [...this.shots.entries()].sort(
        (a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime(),
      )[0];
      if (!oldest) {
        break;
      }
      this.shots.delete(oldest[0]);
    }

    const forClient = [...this.shots.entries()].filter(
      ([, shot]) => shot.clientId === clientId,
    );
    if (forClient.length < MAX_SCREENSHOTS_PER_CLIENT) {
      return;
    }
    forClient
      .sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime())
      .slice(0, forClient.length - MAX_SCREENSHOTS_PER_CLIENT + 1)
      .forEach(([id]) => this.shots.delete(id));
  }

  get(screenshotId: string): StoredScreenshot | undefined {
    return this.shots.get(screenshotId);
  }

  /** Data-URL suitable for Socket.IO screenshot events until HTTP route exists. */
  getDataUrl(screenshotId: string): string | undefined {
    const shot = this.shots.get(screenshotId);
    if (!shot) {
      return undefined;
    }
    return `data:image/jpeg;base64,${shot.buffer.toString('base64')}`;
  }

  clearClient(clientId: string): void {
    for (const [id, shot] of this.shots) {
      if (shot.clientId === clientId) {
        this.shots.delete(id);
      }
    }
  }
}
