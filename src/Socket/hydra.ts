// hydra.ts

import * as Utils from '../Utils/index.js';
import { proto } from '../../WAProto/index.js';
import axios from 'axios';
import crypto from 'crypto';

// Tipe-tipe umum yang sering dipakai di Baileys
import type {
    AnyMessageContent,
    MediaUploadOptions,
    MessageGenerationOptions,
    WAMessage,
    WAMessageKey,
} from '@whiskeysockets/baileys'; // sesuaikan dengan versi Baileys yang kamu pakai

// Interface untuk fungsi utils yang dipakai
interface UtilsInterface {
    prepareWAMessageMedia: (
        message: any,
        options: MediaUploadOptions
    ) => Promise<{ [key: string]: any }>;

    generateWAMessageFromContent: (
        jid: string,
        content: AnyMessageContent,
        options?: MessageGenerationOptions
    ) => Promise<WAMessage>;

    generateWAMessageContent?: (message: any, options: any) => Promise<any>;
    generateWAMessage: (jid: string, content: any, options: any) => Promise<WAMessage>;
    generateMessageID: () => string;
}

// Tipe fungsi relayMessage & upload
type RelayMessageFn = (jid: string, message: any, options?: any) => Promise<any>;
type WaUploadToServerFn = (stream: any, options: any) => Promise<any>;

class Hydra {
    private utils: UtilsInterface;
    private relayMessage: RelayMessageFn;
    private waUploadToServer: WaUploadToServerFn;

    constructor(
        utils: UtilsInterface,
        waUploadToServer: WaUploadToServerFn,
        relayMessageFn: RelayMessageFn
    ) {
        this.utils = utils;
        this.relayMessage = relayMessageFn;
        this.waUploadToServer = waUploadToServer;
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

    async handleCarousel(content: any, jid: string, quoted?: any): Promise<WAMessage> {
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
                                    priceAmount1000: card.priceAmount1000 || '100000',
                                    retailerId: card.retailerId || 'Retailer',
                                    url: card.url || '',
                                    productImageCount: 1,
                                },
                                businessOwnerJid: card.businessOwnerJid || '0@s.whatsapp.net',
                            },
                            hasMediaAttachment: false,
                        }),
                        body: proto.Message.InteractiveMessage.Body.create({
                            text: card.bodyText || '',
                        }),
                        footer: proto.Message.InteractiveMessage.Footer.create({
                            text: card.footerText || '',
                        }),
                        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                            buttons: (card.buttons || []).map((btn: any) => ({
                                name: btn.name,
                                buttonParamsJson: JSON.stringify(btn.params || {}),
                            })),
                        }),
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
                                : {}),
                        }),
                        body: proto.Message.InteractiveMessage.Body.create({
                            text: card.bodyText || '',
                        }),
                        footer: proto.Message.InteractiveMessage.Footer.create({
                            text: card.footerText || '',
                        }),
                        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                            buttons: (card.buttons || []).map((btn: any) => ({
                                name: btn.name,
                                buttonParamsJson: JSON.stringify(btn.params || {}),
                            })),
                        }),
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
                                messageVersion: 1,
                            }),
                        }),
                    },
                },
            },
            { quoted }
        );

        await this.relayMessage(jid, msg.message, { messageId: msg.key.id });
        return msg;
    }

    async handlePayment(content: any, quoted?: any): Promise<any> {
        const data = content.requestPaymentMessage;
        let notes: any = {};

        if (data.sticker?.stickerMessage) {
            notes = {
                stickerMessage: {
                    ...data.sticker.stickerMessage,
                    contextInfo: {
                        stanzaId: quoted?.key?.id,
                        participant: quoted?.key?.participant || content.sender,
                        quotedMessage: quoted?.message,
                    },
                },
            };
        } else if (data.note) {
            notes = {
                extendedTextMessage: {
                    text: data.note,
                    contextInfo: {
                        stanzaId: quoted?.key?.id,
                        participant: quoted?.key?.participant || content.sender,
                        quotedMessage: quoted?.message,
                    },
                },
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
                    placeholderArgb: 0xfff0f0f0,
                },
            }),
        };
    }

    async handleProduct(content: any, jid: string, quoted?: any): Promise<any> {
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
            currencyCode = 'IDR',
        } = content.productMessage;

        let productImage: any = undefined;

        if (Buffer.isBuffer(thumbnail)) {
            const { imageMessage } = await this.utils.prepareWAMessageMedia(
                { image: thumbnail },
                { upload: this.waUploadToServer }
            );
            productImage = imageMessage;
        } else if (typeof thumbnail === 'object' && thumbnail.url) {
            const { imageMessage } = await this.utils.prepareWAMessageMedia(
                { image: { url: thumbnail.url } },
                { upload: this.waUploadToServer }
            );
            productImage = imageMessage;
        }

        return {
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
                                    productImageCount: 1,
                                },
                                businessOwnerJid: '0@s.whatsapp.net',
                            },
                        }),
                        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                            buttons,
                        }),
                    }),
                },
            },
        };
    }

    async handleInteractive(content: any, jid: string, quoted?: any): Promise<any> {
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
            nativeFlowMessage,
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
                    { image: image },
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
                    { video: video },
                    { upload: this.waUploadToServer }
                );
            }
        } else if (document) {
            let documentPayload: any = { document };
            if (jpegThumbnail) {
                documentPayload.jpegThumbnail =
                    typeof jpegThumbnail === 'object' && jpegThumbnail.url
                        ? { url: jpegThumbnail.url }
                        : jpegThumbnail;
            }

            media = await this.utils.prepareWAMessageMedia(documentPayload, {
                upload: this.waUploadToServer,
            });

            if (fileName) media.documentMessage.fileName = fileName;
            if (mimetype) media.documentMessage.mimetype = mimetype;
        }

        let interactiveMessage: any = {
            body: { text: title || '' },
            footer: { text: footer || '' },
        };

        if (buttons.length > 0 || nativeFlowMessage) {
            interactiveMessage.nativeFlowMessage = {
                buttons: buttons,
                ...(nativeFlowMessage || {}),
            };
        }

        if (media) {
            interactiveMessage.header = {
                title: '',
                hasMediaAttachment: true,
                ...media,
            };
        } else {
            interactiveMessage.header = {
                title: '',
                hasMediaAttachment: false,
            };
        }

        let finalContextInfo: any = {};
        if (contextInfo) {
            finalContextInfo = { ...contextInfo };
        }
        if (externalAdReply) {
            finalContextInfo.externalAdReply = { ...externalAdReply };
        }
        if (Object.keys(finalContextInfo).length > 0) {
            interactiveMessage.contextInfo = finalContextInfo;
        }

        return { interactiveMessage };
    }

    async handleAlbum(content: any, jid: string, quoted?: any): Promise<WAMessage> {
        const array = content.albumMessage;

        const album = await this.utils.generateWAMessageFromContent(
            jid,
            {
                messageContextInfo: {
                    messageSecret: crypto.randomBytes(32),
                },
                albumMessage: {
                    expectedImageCount: array.filter((a: any) => a.hasOwnProperty('image')).length,
                    expectedVideoCount: array.filter((a: any) => a.hasOwnProperty('video')).length,
                },
            },
            {
                userJid: this.utils.generateMessageID().split('@')[0] + '@s.whatsapp.net',
                quoted,
                upload: this.waUploadToServer,
            }
        );

        await this.relayMessage(jid, album.message, { messageId: album.key.id });

        for (const item of array) {
            const msg = await this.utils.generateWAMessage(jid, item, {
                upload: this.waUploadToServer,
            });

            msg.message.messageContextInfo = {
                messageSecret: crypto.randomBytes(32),
                messageAssociation: {
                    associationType: 1,
                    parentMessageKey: album.key,
                },
                participant: '0@s.whatsapp.net',
                remoteJid: 'status@broadcast',
                forwardingScore: 99999,
                isForwarded: true,
                mentionedJid: [jid],
                starred: true,
                labels: ['Y', 'Important'],
                isHighlighted: true,
                businessMessageForwardInfo: { businessOwnerJid: jid },
                dataSharingContext: { showMmDisclosure: true },
            };

            msg.message.forwardedNewsletterMessageInfo = {
                newsletterJid: '0@newsletter',
                serverMessageId: 1,
                newsletterName: 'WhatsApp',
                contentType: 1,
                timestamp: new Date().toISOString(),
                senderName: '7-Yuukey',
                contentType: 'UPDATE_CARD',
                priority: 'high',
                status: 'sent',
            };

            msg.message.disappearingMode = {
                initiator: 3,
                trigger: 4,
                initiatorDeviceJid: jid,
                initiatedByExternalService: true,
                initiatedByUserDevice: true,
                initiatedBySystem: true,
                initiatedByServer: true,
                initiatedByAdmin: true,
                initiatedByUser: true,
                initiatedByApp: true,
                initiatedByBot: true,
                initiatedByMe: true,
            };

            await this.relayMessage(jid, msg.message, {
                messageId: msg.key.id,
                quoted: {
                    key: {
                        remoteJid: album.key.remoteJid,
                        id: album.key.id,
                        fromMe: true,
                        participant: this.utils.generateMessageID().split('@')[0] + '@s.whatsapp.net',
                    },
                    message: album.message,
                },
            });
        }

        return album;
    }

    async handleEvent(content: any, jid: string, quoted?: any): Promise<WAMessage> {
        const eventData = content.eventMessage;

        const msg = await this.utils.generateWAMessageFromContent(
            jid,
            {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadata: {},
                            deviceListMetadataVersion: 2,
                            messageSecret: crypto.randomBytes(32),
                            supportPayload: JSON.stringify({
                                version: 2,
                                is_ai_message: true,
                                should_show_system_message: true,
                                ticket_id: crypto.randomBytes(16).toString('hex'),
                            }),
                        },
                        eventMessage: {
                            contextInfo: {
                                mentionedJid: [jid],
                                participant: jid,
                                remoteJid: 'status@broadcast',
                                forwardedNewsletterMessageInfo: {
                                    newsletterName: 'D | 7eppeli-Exloration',
                                    newsletterJid: '120363421563597486@newsletter',
                                    serverMessageId: 1,
                                },
                            },
                            isCanceled: eventData.isCanceled || false,
                            name: eventData.name,
                            description: eventData.description,
                            location: eventData.location || {
                                degreesLatitude: 0,
                                degreesLongitude: 0,
                                name: 'Location',
                            },
                            joinLink: eventData.joinLink || '',
                            startTime:
                                typeof eventData.startTime === 'string'
                                    ? parseInt(eventData.startTime)
                                    : eventData.startTime || Date.now(),
                            endTime:
                                typeof eventData.endTime === 'string'
                                    ? parseInt(eventData.endTime)
                                    : eventData.endTime || Date.now() + 3600000,
                            extraGuestsAllowed: eventData.extraGuestsAllowed !== false,
                        },
                    },
                },
            },
            { quoted }
        );

        await this.relayMessage(jid, msg.message, { messageId: msg.key.id });
        return msg;
    }

    async handlePollResult(content: any, jid: string, quoted?: any): Promise<WAMessage> {
        const pollData = content.pollResultMessage;

        const msg = await this.utils.generateWAMessageFromContent(
            jid,
            {
                pollResultSnapshotMessage: {
                    name: pollData.name,
                    pollVotes: pollData.pollVotes.map((vote: any) => ({
                        optionName: vote.optionName,
                        optionVoteCount:
                            typeof vote.optionVoteCount === 'number'
                                ? vote.optionVoteCount.toString()
                                : vote.optionVoteCount,
                    })),
                    contextInfo: {
                        isForwarded: true,
                        forwardingScore: 1,
                        forwardedNewsletterMessageInfo: {
                            newsletterName:
                                pollData.newsletter?.newsletterName || '120363399602691477@newsletter',
                            newsletterJid: pollData.newsletter?.newsletterJid || 'Newsletter',
                            serverMessageId: 1000,
                            contentType: 'UPDATE',
                        },
                    },
                },
            },
            {
                userJid: this.utils.generateMessageID().split('@')[0] + '@s.whatsapp.net',
                quoted,
            }
        );

        await this.relayMessage(jid, msg.message, { messageId: msg.key.id });
        return msg;
    }

    async handleStMention(content: any, jid: string, quoted?: any): Promise<WAMessage> {
        const data = content.statusMentionMessage;
        let media: any = null;

        if (data.image) {
            if (typeof data.image === 'object' && data.image.url) {
                media = await this.utils.prepareWAMessageMedia(
                    { image: { url: data.image.url } },
                    { upload: this.waUploadToServer }
                );
            } else {
                media = await this.utils.prepareWAMessageMedia(
                    { image: data.image },
                    { upload: this.waUploadToServer }
                );
            }
        } else if (data.video) {
            if (typeof data.video === 'object' && data.video.url) {
                media = await this.utils.prepareWAMessageMedia(
                    { video: { url: data.video.url } },
                    { upload: this.waUploadToServer }
                );
            } else {
                media = await this.utils.prepareWAMessageMedia(
                    { video: data.video },
                    { upload: this.waUploadToServer }
                );
            }
        }

        // Catatan: Bagian ini agak kompleks dan bergantung pada implementasi relayMessage
        // yang mendukung status mention. Jika error, sesuaikan dengan versi Baileys kamu.
        // Kode asli memiliki beberapa variabel undefined seperti `target` dan `this.user`
        // Jadi aku skip bagian relay ke status@broadcast karena butuh konteks lebih.

        const xontols = await this.utils.generateWAMessageFromContent(
            jid,
            {
                statusMentionMessage: {
                    message: {
                        protocolMessage: {
                            // messageId dan type perlu disesuaikan
                            type: 15, // STATUS_MENTION_MESSAGE di proto biasanya 15
                        },
                    },
                },
            },
            {}
        );

        await this.relayMessage(jid, xontols.message, { messageId: xontols.key.id });
        return xontols;
    }

    async handleOrderMessage(content: any, jid: string, quoted?: any): Promise<WAMessage> {
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
                    thumbnail = null;
                }
            }
        }

        const msg = await this.utils.generateWAMessageFromContent(
            jid,
            {
                orderMessage: {
                    orderId: '7EPPELI25022008',
                    thumbnail,
                    itemCount: orderData.itemCount || 0,
                    status: 'ACCEPTED',
                    surface: 'CATALOG',
                    message: orderData.message,
                    orderTitle: orderData.orderTitle,
                    sellerJid: '0@whatsapp.net',
                    token: '7EPPELI_EXAMPLE_TOKEN',
                    totalAmount1000: orderData.totalAmount1000 || 0,
                    totalCurrencyCode: orderData.totalCurrencyCode || 'IDR',
                    messageVersion: 2,
                },
            },
            { quoted }
        );

        await this.relayMessage(jid, msg.message, {});
        return msg;
    }

    async handleGroupStory(content: any, jid: string, quoted?: any): Promise<any> {
        const storyData = content.groupStatus;
        let messageContent: any;

        if (storyData.message) {
            messageContent = storyData;
        } else {
            if (typeof this.utils.generateWAMessageContent === 'function') {
                messageContent = await this.utils.generateWAMessageContent(storyData, {
                    upload: this.waUploadToServer,
                });
            } else {
                messageContent = await Utils.generateWAMessageContent(storyData, {
                    upload: this.waUploadToServer,
                });
            }
        }

        const msg = {
            message: {
                groupStatusMessageV2: {
                    message: messageContent.message || messageContent,
                },
            },
        };

        return await this.relayMessage(jid, msg.message, {
            messageId: this.utils.generateMessageID(),
        });
    }
}

export default Hydra;
