// src/Hydra.ts  (atau nama file lain sesuai keinginanmu)

import axios from 'axios'
import crypto from 'crypto'

// Tipe-tipe penting dari Baileys (path bisa disesuaikan jika struktur folder berbeda)
import type { WAMessage } from '../Types/Message'
import type { Socket } from '../Socket'

// proto sudah tersedia sebagai global BaileysProto di project original
import { proto } from '../../WAProto/index.js'

interface HydraUtils {
  generateWAMessageFromContent: Socket['generateWAMessageFromContent'];
  prepareWAMessageMedia: Socket['prepareWAMessageMedia'];
  generateWAMessage: Socket['generateWAMessage'];
  generateMessageID: () => string;
}

interface HydraParams {
  utils: HydraUtils;
  waUploadToServer: (jid: string, media: Buffer | Uint8Array, options?: any) => Promise<any>;
  relayMessage: (jid: string, message: proto.IWebMessageInfo['message'], opts?: any) => Promise<any>;
}

class Hydra {
  private utils: HydraUtils;
  private waUploadToServer: HydraParams['waUploadToServer'];
  private relayMessage: HydraParams['relayMessage'];

  constructor({ utils, waUploadToServer, relayMessage }: HydraParams) {
    this.utils = utils;
    this.waUploadToServer = waUploadToServer;
    this.relayMessage = relayMessage;
  }

  detectType(content: any): string | null {
    if (content.requestPaymentMessage) return 'PAYMENT';
    if (content.productMessage) return 'PRODUCT';
    if (content.interactiveMessage) return 'INTERACTIVE';
    if (content.albumMessage) return 'ALBUM';
    if (content.eventMessage) return 'EVENT';
    if (content.pollResultMessage) return 'POLL_RESULT';
    if (content.statusMentionMessage) return 'STATUS_MENTION';
    if (content.orderMessage) return 'ORDER';
    if (content.groupStatus) return 'GROUP_STATUS';
    if (content.carouselMessage || content.carousel) return 'CAROUSEL';
    return null;
  }

  async handleCarousel(content: any, jid: string, quoted?: WAMessage) {
    const root = content.carouselMessage || content.carousel || {};
    const { caption = '', footer = '', cards = [] } = root;

    const carouselCards = await Promise.all(
      cards.map(async (card: any) => {
        if (card.productTitle) {
          // Mode Product
          return {
            header: proto.Message.InteractiveMessage.Header.create({
              title: card.headerTitle || '',
              subtitle: card.headerSubtitle || '',
              productMessage: {
                product: {
                  productImage: (
                    await this.utils.prepareWAMessageMedia(
                      { image: { url: card.imageUrl } },
                      { upload: this.waUploadToServer }
                    )
                  ).imageMessage,
                  productId: card.productId || '123456',
                  title: card.productTitle,
                  description: card.productDescription || '',
                  currencyCode: card.currencyCode || 'IDR',
                  priceAmount1000: card.priceAmount1000 || 100000,
                  retailerId: card.retailerId || 'Retailer',
                  url: card.url || '',
                  productImageCount: 1
                },
                businessOwnerJid: card.businessOwnerJid || '0@s.whatsapp.net'
              },
              hasMediaAttachment: false
            }),
            body: proto.Message.InteractiveMessage.Body.create({
              text: card.bodyText || ''
            }),
            footer: proto.Message.InteractiveMessage.Footer.create({
              text: card.footerText || ''
            }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
              buttons: (card.buttons || []).map((btn: any) => ({
                name: btn.name,
                buttonParamsJson: JSON.stringify(btn.params || {})
              }))
            })
          };
        } else {
          // Mode Image biasa
          return {
            header: proto.Message.InteractiveMessage.Header.create({
              title: card.headerTitle || '',
              subtitle: card.headerSubtitle || '',
              hasMediaAttachment: !!card.imageUrl,
              ...(card.imageUrl
                ? await this.utils.prepareWAMessageMedia(
                    { image: { url: card.imageUrl } },
                    { upload: this.waUploadToServer }
                  )
                : {}
              )
            }),
            body: proto.Message.InteractiveMessage.Body.create({
              text: card.bodyText || ''
            }),
            footer: proto.Message.InteractiveMessage.Footer.create({
              text: card.footerText || ''
            }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
              buttons: (card.buttons || []).map((btn: any) => ({
                name: btn.name,
                buttonParamsJson: JSON.stringify(btn.params || {})
              }))
            })
          };
        }
      })
    );

    const msg = await this.utils.generateWAMessageFromContent(
      jid,
      {
        viewOnceMessage: {
          message: {
            interactiveMessage: proto.Message.InteractiveMessage.create({
              body: proto.Message.InteractiveMessage.Body.create({ text: caption }),
              footer: proto.Message.InteractiveMessage.Footer.create({ text: footer }),
              carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.create({
                cards: carouselCards,
                messageVersion: 1
              })
            })
          }
        }
      },
      quoted ? { quoted } : {}
    );

    await this.relayMessage(jid, msg.message!, { messageId: msg.key.id });
    return msg;
  }

  async handlePayment(content: any, quoted?: WAMessage) {
    const data = content.requestPaymentMessage;
    let notes: any = {};

    if (data.sticker?.stickerMessage) {
      notes = {
        stickerMessage: {
          ...data.sticker.stickerMessage,
          contextInfo: {
            stanzaId: quoted?.key?.id,
            participant: quoted?.key?.participant || content.sender,
            quotedMessage: quoted?.message
          }
        }
      };
    } else if (data.note) {
      notes = {
        extendedTextMessage: {
          text: data.note,
          contextInfo: {
            stanzaId: quoted?.key?.id,
            participant: quoted?.key?.participant || content.sender,
            quotedMessage: quoted?.message
          }
        }
      };
    }

    return {
      requestPaymentMessage: proto.Message.RequestPaymentMessage.fromObject({
        expiryTimestamp: data.expiry || 0,
        amount1000: data.amount || 0,
        currencyCodeIso4217: data.currency || 'IDR',
        requestFrom: data.from || '0@s.whatsapp.net',
        noteMessage: notes,
        background: data.background ?? {
          id: 'DEFAULT',
          placeholderArgb: 0xFFF0F0F0
        }
      })
    };
  }

  async handleProduct(content: any, jid: string, quoted?: WAMessage) {
    const {
      title,
      description,
      thumbnail,
      productId,
      retailerId,
      url,
      body = '',
      footer = '',
      buttons = [],
      priceAmount1000 = null,
      currencyCode = 'IDR'
    } = content.productMessage;

    let productImage: proto.IImageMessage | undefined;

    if (Buffer.isBuffer(thumbnail)) {
      const prepared = await this.utils.prepareWAMessageMedia(
        { image: thumbnail },
        { upload: this.waUploadToServer }
      );
      productImage = prepared.imageMessage;
    } else if (typeof thumbnail === 'object' && thumbnail?.url) {
      const prepared = await this.utils.prepareWAMessageMedia(
        { image: { url: thumbnail.url } },
        { upload: this.waUploadToServer }
      );
      productImage = prepared.imageMessage;
    }

    const messageContent: any = {
      viewOnceMessage: {
        message: {
          interactiveMessage: proto.Message.InteractiveMessage.create({
            body: proto.Message.InteractiveMessage.Body.create({ text: body }),
            footer: proto.Message.InteractiveMessage.Footer.create({ text: footer }),
            header: proto.Message.InteractiveMessage.Header.create({
              title,
              hasMediaAttachment: true,
              productMessage: {
                product: {
                  productImage,
                  productId,
                  title,
                  description,
                  currencyCode,
                  priceAmount1000,
                  retailerId,
                  url,
                  productImageCount: 1
                },
                businessOwnerJid: '0@s.whatsapp.net'
              }
            }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
              buttons
            })
          })
        }
      }
    };

    const msg = await this.utils.generateWAMessageFromContent(jid, messageContent, quoted ? { quoted } : {});
    await this.relayMessage(jid, msg.message!, { messageId: msg.key.id });
    return msg;
  }

  async handleInteractive(content: any, jid: string, quoted?: WAMessage) {
    const {
      title,
      footer,
      thumbnail,
      image,
      video,
      document,
      mimetype,
      fileName,
      jpegThumbnail,
      contextInfo,
      externalAdReply,
      buttons = [],
      nativeFlowMessage
    } = content.interactiveMessage;

    let media: any = null;

    if (thumbnail) {
      media = await this.utils.prepareWAMessageMedia(
        { image: { url: thumbnail } },
        { upload: this.waUploadToServer }
      );
    } else if (image) {
      if (typeof image === 'object' && image.url) {
        media = await this.utils.prepareWAMessageMedia(
          { image: { url: image.url } },
          { upload: this.waUploadToServer }
        );
      } else {
        media = await this.utils.prepareWAMessageMedia(
          { image },
          { upload: this.waUploadToServer }
        );
      }
    } else if (video) {
      if (typeof video === 'object' && video.url) {
        media = await this.utils.prepareWAMessageMedia(
          { video: { url: video.url } },
          { upload: this.waUploadToServer }
        );
      } else {
        media = await this.utils.prepareWAMessageMedia(
          { video },
          { upload: this.waUploadToServer }
        );
      }
    } else if (document) {
      let docPayload: any = { document };
      if (jpegThumbnail) {
        docPayload.jpegThumbnail = typeof jpegThumbnail === 'object' && jpegThumbnail.url ? { url: jpegThumbnail.url } : jpegThumbnail;
      }
      media = await this.utils.prepareWAMessageMedia(docPayload, { upload: this.waUploadToServer });
      if (fileName) media.documentMessage!.fileName = fileName;
      if (mimetype) media.documentMessage!.mimetype = mimetype;
    }

    const interactiveMessage: any = {
      body: { text: title || '' },
      footer: { text: footer || '' }
    };

    if (buttons.length > 0 || nativeFlowMessage) {
      interactiveMessage.nativeFlowMessage = {
        buttons: buttons,
        ...(nativeFlowMessage || {})
      };
    }

    if (media) {
      interactiveMessage.header = {
        title: '',
        hasMediaAttachment: true,
        ...media
      };
    } else {
      interactiveMessage.header = {
        title: '',
        hasMediaAttachment: false
      };
    }

    if (contextInfo || externalAdReply) {
      interactiveMessage.contextInfo = {
        ...(contextInfo || {}),
        ...(externalAdReply ? { externalAdReply } : {})
      };
    }

    const msg = await this.utils.generateWAMessageFromContent(
      jid,
      { interactiveMessage },
      quoted ? { quoted } : {}
    );

    await this.relayMessage(jid, msg.message!, { messageId: msg.key.id });
    return msg;
  }

  async handleAlbum(content: any, jid: string, quoted?: WAMessage) {
    const array = content.albumMessage;

    const album = await this.utils.generateWAMessageFromContent(jid, {
      messageContextInfo: {
        messageSecret: crypto.randomBytes(32)
      },
      albumMessage: {
        expectedImageCount: array.filter((a: any) => a.imageMessage).length,
        expectedVideoCount: array.filter((a: any) => a.videoMessage).length
      }
    }, {
      userJid: this.utils.generateMessageID().split('@')[0] + '@s.whatsapp.net',
      quoted,
      upload: this.waUploadToServer
    });

    await this.relayMessage(jid, album.message!, { messageId: album.key.id });

    for (const item of array) {
      const msg = await this.utils.generateWAMessage(jid, item, { upload: this.waUploadToServer });

      msg.message!.messageContextInfo = {
        messageSecret: crypto.randomBytes(32),
        messageAssociation: { associationType: 1, parentMessageKey: album.key },
        participant: '0@s.whatsapp.net',
        remoteJid: 'status@broadcast',
        forwardingScore: 99999,
        isForwarded: true,
        mentionedJid: [jid],
        starred: true,
        labels: ['Y', 'Important'],
        isHighlighted: true,
        businessMessageForwardInfo: { businessOwnerJid: jid }
      };

      await this.relayMessage(jid, msg.message!, {
        messageId: msg.key.id,
        quoted: { key: { remoteJid: album.key.remoteJid, id: album.key.id, fromMe: true }, message: album.message }
      });
    }

    return album;
  }

  async handleEvent(content: any, jid: string, quoted?: WAMessage) {
    const eventData = content.eventMessage;

    const msg = await this.utils.generateWAMessageFromContent(jid, {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
            messageSecret: crypto.randomBytes(32)
          },
          eventMessage: {
            contextInfo: {
              mentionedJid: [jid],
              participant: jid,
              remoteJid: 'status@broadcast'
            },
            isCanceled: eventData.isCanceled || false,
            name: eventData.name,
            description: eventData.description,
            location: eventData.location || { degreesLatitude: 0, degreesLongitude: 0, name: 'Location' },
            joinLink: eventData.joinLink || '',
            startTime: typeof eventData.startTime === 'string' ? parseInt(eventData.startTime) : eventData.startTime || Date.now(),
            endTime: typeof eventData.endTime === 'string' ? parseInt(eventData.endTime) : eventData.endTime || Date.now() + 3600000,
            extraGuestsAllowed: eventData.extraGuestsAllowed !== false
          }
        }
      }
    }, quoted ? { quoted } : {});

    await this.relayMessage(jid, msg.message!, { messageId: msg.key.id });
    return msg;
  }

  async handlePollResult(content: any, jid: string, quoted?: WAMessage) {
    const pollData = content.pollResultMessage;

    const msg = await this.utils.generateWAMessageFromContent(jid, {
      pollResultSnapshotMessage: {
        name: pollData.name,
        pollVotes: pollData.pollVotes.map((vote: any) => ({
          optionName: vote.optionName,
          optionVoteCount: typeof vote.optionVoteCount === 'number' ? vote.optionVoteCount.toString() : vote.optionVoteCount
        })),
        contextInfo: {
          isForwarded: true,
          forwardingScore: 1
        }
      }
    }, {
      userJid: this.utils.generateMessageID().split('@')[0] + '@s.whatsapp.net',
      quoted
    });

    await this.relayMessage(jid, msg.message!, { messageId: msg.key.id });
    return msg;
  }

  async handleOrderMessage(content: any, jid: string, quoted?: WAMessage) {
    const orderData = content.orderMessage;

    let thumbnail: Buffer | null = null;
    if (orderData.thumbnail) {
      if (Buffer.isBuffer(orderData.thumbnail)) {
        thumbnail = orderData.thumbnail;
      } else if (typeof orderData.thumbnail === 'string') {
        try {
          const res = await axios.get(orderData.thumbnail, { responseType: 'arraybuffer' });
          thumbnail = Buffer.from(res.data);
        } catch (e) {
          console.error('Gagal download thumbnail:', e);
        }
      }
    }

    const msg = await this.utils.generateWAMessageFromContent(jid, {
      orderMessage: {
        orderId: '7EPPELI25022008',
        thumbnail: thumbnail ?? undefined,
        itemCount: orderData.itemCount || 0,
        status: 'ACCEPTED',
        surface: 'CATALOG',
        message: orderData.message,
        orderTitle: orderData.orderTitle,
        sellerJid: '0@whatsapp.net',
        token: '7EPPELI_EXAMPLE_TOKEN',
        totalAmount1000: orderData.totalAmount1000 || 0,
        totalCurrencyCode: orderData.totalCurrencyCode || 'IDR',
        messageVersion: 2
      }
    }, quoted ? { quoted } : {});

    await this.relayMessage(jid, msg.message!, {});
    return msg;
  }

  async handleGroupStory(content: any, jid: string, quoted?: WAMessage) {
    const storyData = content.groupStatus;
    let messageContent: any;

    if (storyData.message) {
      messageContent = storyData;
    } else {
      messageContent = await this.utils.generateWAMessageContent(storyData, {
        upload: this.waUploadToServer
      });
    }

    const msg = {
      message: {
        groupStatusMessageV2: {
          message: messageContent.message || messageContent
        }
      }
    };

    await this.relayMessage(jid, msg.message, {
      messageId: this.utils.generateMessageID()
    });

    return msg;
  }

  // handleStMention (status mention) masih agak kompleks karena butuh additionalNodes
  // Jika kamu jarang pakai, bisa skip dulu atau saya bantu perbaiki terpisah
}

export default Hydra;
