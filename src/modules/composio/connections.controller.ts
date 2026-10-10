import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUserId, UserGuard } from '@modules/security/user.guard';
import { ComposioService } from './composio.service';
import { parseShopifyHandle } from './shopify-domain';

const shopifyBodySchema = z.object({ shop: z.string().min(1).max(300) });

/** Toolkits shown on the connected-apps screen. Shopify is the first one with OAuth. */
const LISTED_TOOLKITS = ['shopify'] as const;

@Controller('connections')
@UseGuards(UserGuard)
export class ConnectionsController {
  constructor(private readonly composio: ComposioService) {}

  @Get()
  async list(@CurrentUserId() userId: string) {
    const stored = await this.composio.listConnections(userId);
    return LISTED_TOOLKITS.map((toolkit) => {
      const row = stored.find((item) => item.toolkit === toolkit);
      return {
        toolkit,
        available: this.composio.supportsOAuth(toolkit),
        status: row?.status ?? 'disconnected',
        shop: row?.metadata?.subdomain ?? null,
      };
    });
  }

  /** Returns the secure OAuth link for the web app to open in a popup. */
  @Post('shopify')
  async connectShopify(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = shopifyBodySchema.safeParse(body);
    const handle = parsed.success ? parseShopifyHandle(parsed.data.shop) : null;
    if (!handle) {
      throw new BadRequestException(
        'Enter your store name, like acme from acme.myshopify.com.',
      );
    }
    if (!this.composio.supportsOAuth('shopify')) {
      throw new BadGatewayException('Shopify connections are not set up yet.');
    }
    const access = await this.composio.requestAccess(userId, 'shopify', {
      subdomain: handle,
    });
    if (access.mode !== 'composio') {
      throw new BadGatewayException(
        'Could not start a secure Shopify connection. Try again in a moment.',
      );
    }
    return { connectUrl: access.connectUrl, shop: handle };
  }

  @Delete(':toolkit')
  async disconnect(
    @CurrentUserId() userId: string,
    @Param('toolkit') toolkit: string,
  ) {
    const normalized = this.composio.normalizeToolkit(toolkit);
    if (!(LISTED_TOOLKITS as readonly string[]).includes(normalized)) {
      throw new BadRequestException('Unknown app');
    }
    const ok = await this.composio.disconnect(userId, normalized);
    if (!ok) {
      throw new BadGatewayException('Could not disconnect right now.');
    }
    return { ok: true };
  }
}
