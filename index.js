require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField
} = require('discord.js');
const fs = require('fs').promises; // Используем промисы для файловых операций
const path = require('path');
const Gamedig = require('gamedig');
const axios = require('axios');
const { setIntervalAsync } = require('set-interval-async/dynamic'); // Для безопасных интервалов

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Конфигурация
const CONFIG = {
  CATEGORY_NAME: '📶│МОНИТОРИНГ',
  TEXT_CHANNEL_NAME: '🛰️ статус серверов',
  UPDATE_INTERVAL: 60_000,
  PROJECT_INFO_ID: 'project_info_message',
  MESSAGES_PATH: path.join(__dirname, 'data', 'messages.json'),
  SERVERS_PATH: path.join(__dirname, 'config', 'servers.json'),
  TIMEOUTS: {
    GAMEDIG: 10_000,
    AXIOS: 5_000,
    CHANNEL_OPERATIONS: 15_000
  },
  RETRIES: {
    GAMEDIG: 3,
    AXIOS: 2
  }
};

// Порядок серверов
const SERVER_ORDER = [
  'Metrostroi #1',
  'Metrostroi #2',
  'SCP:SL', 
  'AlcoMine'  
];

class ServerMonitor {
  constructor() {
    this.messageData = {};
    this.servers = [];
    this.initialized = false;
    this.currentUpdates = new Set();
  }

  async initialize() {
    try {
      await this.loadData();
      await this.validateServers();
      this.initialized = true;
    } catch (error) {
      console.error('Initialization failed:', error);
      process.exit(1);
    }
  }

  async loadData() {
    try {
      // Загрузка конфигурации серверов
      const serversData = await fs.readFile(CONFIG.SERVERS_PATH, 'utf8');
      this.servers = JSON.parse(serversData);
      
      // Загрузка сохраненных сообщений
      try {
        const data = await fs.readFile(CONFIG.MESSAGES_PATH, 'utf8');
        this.messageData = JSON.parse(data);
      } catch {
        this.messageData = {};
      }
    } catch (error) {
      console.error('Failed to load data:', error);
      throw error;
    }
  }

  async saveMessages() {
    try {
      await fs.mkdir(path.dirname(CONFIG.MESSAGES_PATH), { recursive: true });
      await fs.writeFile(CONFIG.MESSAGES_PATH, JSON.stringify(this.messageData, null, 2));
    } catch (error) {
      console.error('Failed to save messages:', error);
    }
  }

  validateServers() {
    this.orderedServers = SERVER_ORDER.map(name => {
      const server = this.servers.find(s => s.name === name);
      if (!server) {
        console.error(`Server ${name} not found in configuration!`);
        return null;
      }
      return server;
    }).filter(Boolean);

    if (this.orderedServers.length === 0) {
      throw new Error('No valid servers found in configuration');
    }
  }

  // ==================== Server Query Functions ====================

  async queryMetrostroiServer(ip, port) {
    try {
      const result = await Gamedig.query({
        type: 'garrysmod',
        host: ip,
        port: port,
        socketTimeout: CONFIG.TIMEOUTS.GAMEDIG,
        maxAttempts: CONFIG.RETRIES.GAMEDIG
      });

      const playerList = result.players.map(p => p.name || 'Неизвестный игрок');

      return {
        online: true,
        players: result.players.length,
        maxplayers: result.maxplayers,
        map: result.map,
        playerList,
        raw: result
      };
    } catch (err) {
      console.error('Metrostroi query error:', err.message);
      return { online: false };
    }
  }

  async querySCPServer() {
    try {
      const response = await axios.get('https://api2.vodka-pro.ru/status/scpsl', {
        timeout: CONFIG.TIMEOUTS.AXIOS,
        headers: {
          'Cache-Control': 'no-cache',
          'Accept': 'application/json'
        },
        maxRedirects: 2
      });

      // Валидация ответа
      if (!response.data || typeof response.data !== 'object') {
        throw new Error('Invalid API response format');
      }

      const data = response.data;
      const online = data.online === true || data.status === 'online';
      const players = data.players || data.onlineCount || 0;
      const maxplayers = data.maxPlayers || 30;

      return {
        online,
        players,
        maxplayers,
        serverName: data.name || 'SCP:SL'
      };
    } catch (err) {
      console.error('SCP API error:', err.message);
      return { 
        online: false,
        players: 0,
        maxplayers: 30,
        serverName: 'SCP:SL'
      };
    }
  }

  async queryMinecraftServer(ip, port) {
    try {
      const result = await Gamedig.query({
        type: 'minecraft',
        host: ip,
        port: port,
        socketTimeout: CONFIG.TIMEOUTS.GAMEDIG,
        maxAttempts: CONFIG.RETRIES.GAMEDIG,
        attemptTimeout: CONFIG.TIMEOUTS.GAMEDIG
      });

      return {
        online: true,
        players: result.raw?.vanilla?.players?.length || result.players.length,
        maxplayers: result.raw?.vanilla?.maxplayers || result.maxplayers,
        raw: result
      };
    } catch (err) {
      console.error('Minecraft query error:', err.message);
      return { online: false };
    }
  }

  // ==================== Discord Operations ====================

  async cleanupOldMessages(textChannel) {
    try {
      const messages = await textChannel.messages.fetch({ limit: 50 });
      const savedMessageIds = new Set(Object.values(this.messageData));
      
      const deletePromises = [];
      for (const [id, message] of messages) {
        if (!savedMessageIds.has(id) && message.author.id === client.user.id) {
          deletePromises.push(message.delete().catch(e => 
            console.error('Failed to delete message:', e.message)
          ));
        }
      }

      await Promise.all(deletePromises);
    } catch (err) {
      console.error('Error cleaning up messages:', err.message);
    }
  }

  async updateProjectInfoMessage(textChannel) {
    const embed = new EmbedBuilder()
      .setTitle('📌 Наша коллекция сервера Metrostroi VP Norank ')
      .setDescription(`ㅤ
        [Ссылка на Steam Workshop](https://steamcommunity.com/sharedfiles/filedetails/?id=2903637092)
      `)
      .setColor('#5865F2')
      .setThumbnail('https://vodka-pro.ru/img/logo.png')
      .setFooter({ text: 'VODKA Project' });

    try {
      if (this.messageData[CONFIG.PROJECT_INFO_ID]) {
        try {
          const msg = await textChannel.messages.fetch(this.messageData[CONFIG.PROJECT_INFO_ID]);
          await msg.edit({ embeds: [embed] });
          return;
        } catch {
          delete this.messageData[CONFIG.PROJECT_INFO_ID];
        }
      }

      const sent = await textChannel.send({ embeds: [embed] });
      this.messageData[CONFIG.PROJECT_INFO_ID] = sent.id;
      await this.saveMessages();
    } catch (err) {
      console.error('Error updating project info:', err.message);
    }
  }

  async setupChannels(guild) {
    let channels;
    try {
      channels = await guild.channels.fetch();
    } catch (err) {
      console.error('Failed to fetch channels:', err.message);
      throw err;
    }

    // Создание/получение категории
    let category = channels.find(c => 
      c.type === ChannelType.GuildCategory && 
      c.name === CONFIG.CATEGORY_NAME
    );

    if (!category) {
      try {
        category = await guild.channels.create({
          name: CONFIG.CATEGORY_NAME,
          type: ChannelType.GuildCategory,
          permissionOverwrites: [{
            id: guild.roles.everyone,
            allow: [PermissionsBitField.Flags.ViewChannel]
          }]
        });
      } catch (err) {
        console.error('Failed to create category:', err.message);
        throw err;
      }
    }

    // Создание/обновление голосовых каналов
    const voiceChannelPromises = this.orderedServers.map(async srv => {
      const existing = channels.find(c => 
        c.type === ChannelType.GuildVoice && 
        c.name.includes(srv.name) && 
        c.parentId === category.id
      );

      if (!existing) {
        try {
          await guild.channels.create({
            name: `🔴 ${srv.name} (Offline)`,
            type: ChannelType.GuildVoice,
            parent: category.id,
            permissionOverwrites: [
              {
                id: guild.roles.everyone,
                deny: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.Connect,
                  PermissionsBitField.Flags.Speak
                ]
              }
            ]
          });
        } catch (err) {
          console.error(`Failed to create voice channel for ${srv.name}:`, err.message);
        }
      }
    });

    await Promise.all(voiceChannelPromises);

    // Создание/получение текстового канала
    let textChannel = this.messageData.textChannelId 
      ? await guild.channels.fetch(this.messageData.textChannelId).catch(() => null)
      : null;

    if (!textChannel) {
      try {
        textChannel = await guild.channels.create({
          name: CONFIG.TEXT_CHANNEL_NAME,
          type: ChannelType.GuildText,
          parent: category.id,
          permissionOverwrites: [{
            id: guild.roles.everyone,
            allow: [PermissionsBitField.Flags.ViewChannel],
            deny: [PermissionsBitField.Flags.SendMessages]
          }]
        });
        this.messageData.textChannelId = textChannel.id;
        await this.saveMessages();
      } catch (err) {
        console.error('Failed to create text channel:', err.message);
        throw err;
      }
    } else {
      await this.cleanupOldMessages(textChannel);
    }

    await this.updateProjectInfoMessage(textChannel);
    return { category, textChannel };
  }

  async updateServerStatus(guild, category, textChannel) {
    if (!this.initialized) {
      console.error('Monitor not initialized');
      return;
    }

    // Используем Set для отслеживания текущих обновлений
    const updateId = Date.now().toString();
    this.currentUpdates.add(updateId);

    try {
      await this.cleanupOldMessages(textChannel);

      // Обрабатываем серверы последовательно с задержкой между ними
      for (const srv of this.orderedServers) {
        if (!this.currentUpdates.has(updateId)) return; // Проверяем, не отменено ли обновление

        try {
          await this.processServer(srv, guild, category, textChannel);
          await new Promise(resolve => setTimeout(resolve, 1000)); // Задержка между серверами
        } catch (err) {
          console.error(`Error processing server ${srv.name}:`, err.message);
        }
      }
    } finally {
      this.currentUpdates.delete(updateId);
    }
  }

  async processServer(srv, guild, category, textChannel) {
    let online = false;
    let numplayers = 0;
    let maxplayers = srv.maxplayers || 20;
    let ipDisplay = `${srv.ip}:${srv.port}`;
    let serverName = srv.name;
    let queryResult;

    // Запрос статуса сервера
    try {
      switch (srv.type) {
        case 'garrysmod':
          queryResult = await this.queryMetrostroiServer(srv.ip, srv.port);
          break;
        case 'scp':
          queryResult = await this.querySCPServer();
          serverName = queryResult.serverName;
          break;
        case 'minecraft':
          queryResult = await this.queryMinecraftServer(srv.ip, srv.port);
          break;
        default:
          console.error(`Unknown server type: ${srv.type}`);
          queryResult = { online: false };
      }

      if (queryResult) {
        online = queryResult.online;
        if (online) {
          numplayers = queryResult.players ?? 0;
          maxplayers = queryResult.maxplayers ?? maxplayers;
        }
      }
    } catch (err) {
      console.error(`Error querying ${srv.name}:`, err.message);
      online = false;
    }

    // Обновление голосового канала
    await this.updateVoiceChannel(srv, guild, category, online, numplayers, maxplayers, serverName);

    // Создание и отправка embed
    await this.sendServerEmbed(srv, textChannel, online, numplayers, maxplayers, ipDisplay, serverName, queryResult);
  }

  async updateVoiceChannel(srv, guild, category, online, numplayers, maxplayers, serverName) {
    try {
      const voice = guild.channels.cache.find(
        c => c.type === ChannelType.GuildVoice && 
             c.name.includes(srv.name) && 
             c.parentId === category.id
      );
      
      if (voice) {
        const playersLabel = online ? `${numplayers}/${maxplayers}` : 'Offline';
        let newName = `${online ? '🟢' : '🔴'} ${serverName} (${playersLabel})`;
        
        // Обрезаем имя, если оно слишком длинное
        if (newName.length > 100) {
          newName = newName.substring(0, 97) + '...';
        }
        
        if (voice.name !== newName) {
          await voice.setName(newName);
        }

        // Обновляем разрешения
        const perms = voice.permissionOverwrites.cache.get(guild.roles.everyone.id);
        const shouldView = online && (!perms || perms.deny.has(PermissionsBitField.Flags.ViewChannel));

        if (shouldView) {
          await voice.permissionOverwrites.edit(guild.roles.everyone, {
            ViewChannel: true,
            Connect: online,
            Speak: false
          });
        }
      }
    } catch (err) {
      console.error(`Error updating voice channel for ${serverName}:`, err.message);
    }
  }

  async sendServerEmbed(srv, textChannel, online, numplayers, maxplayers, ipDisplay, serverName, queryResult) {
    const embed = new EmbedBuilder()
      .setTitle(`${online ? '🟢' : '🔴'} ${serverName}`)
      .setColor(online ? '#43B581' : '#F04747')
      .setTimestamp();

    // Настройки для разных типов серверов
    switch (srv.type) {
      case 'garrysmod':
        this.buildGmodEmbed(embed, online, numplayers, maxplayers, ipDisplay, queryResult);
        break;
      case 'scp':
        embed
          .setDescription('🔻 SCP: Secret Laboratory')
          .addFields(
            { name: '🌐 Адрес', value: `\`${ipDisplay}\``, inline: true },
            { name: '🔹 Статус', value: online ? 'Онлайн' : 'Оффлайн', inline: true },
            { name: '👥 Игроки', value: `${numplayers}/${maxplayers}`, inline: true }
          );
        break;
      case 'minecraft':
        embed
          .setDescription('⛏️ Minecraft Server')
          .addFields(
            { name: '🌐 Адрес', value: `\`${ipDisplay}\``, inline: true },
            { name: '🔹 Статус', value: online ? 'Онлайн' : 'Оффлайн', inline: true },
            { name: '👥 Игроки', value: `${numplayers}/${maxplayers}`, inline: true }
          );
        break;
    }

    // Кнопка подключения
    const row = srv.type !== 'minecraft' ? new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Подключиться')
        .setStyle(ButtonStyle.Link)
        .setURL(srv.connect)
    ) : null;

    // Обновление сообщения
    try {
      const key = srv.name;
      
      if (this.messageData[key]) {
        try {
          const msg = await textChannel.messages.fetch(this.messageData[key]);
          await msg.edit({ 
            embeds: [embed], 
            components: row ? [row] : [] 
          });
          return;
        } catch {
          delete this.messageData[key];
          await this.saveMessages();
        }
      }

      const sent = await textChannel.send({ 
        embeds: [embed], 
        components: row ? [row] : [] 
      });
      this.messageData[key] = sent.id;
      await this.saveMessages();
    } catch (err) {
      console.error(`Error sending message for ${serverName}:`, err.message);
    }
  }

  buildGmodEmbed(embed, online, numplayers, maxplayers, ipDisplay, queryResult) {
    let playersFieldValue = 'Нет игроков онлайн';
    if (queryResult?.online && queryResult.playerList?.length > 0) {
      playersFieldValue = queryResult.playerList
        .slice(0, 20)
        .map((name, idx) => `${idx + 1}. ${name}`)
        .join('\n');
      
      if (queryResult.playerList.length > 20) {
        playersFieldValue += `\n...и ещё ${queryResult.playerList.length - 20}`;
      }
    }

    embed
      .setDescription('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      .addFields(
        { name: '🌐 Адрес', value: `\`${ipDisplay}\``, inline: true },
        { name: '🔹 Статус', value: online ? 'Онлайн' : 'Оффлайн\смена карты', inline: true },
        { name: '👥 Игроки', value: `${numplayers}/${maxplayers}`, inline: true },
        { name: '🗺️ Карта', value: queryResult?.map || 'Неизвестно' },
        { name: '📋 Список игроков', value: playersFieldValue }
      );
      
    if (queryResult?.map && queryResult.map !== 'Unknown') {
      embed.setThumbnail(`https://dev.novanautilus.net/images/${queryResult.map.replace(/ /g, '_')}.jpg`);
    }
  }
}

// Инициализация и запуск бота
const monitor = new ServerMonitor();

client.once('ready', async () => {
  console.log(`Bot started as ${client.user.tag}`);
  
  try {
    await monitor.initialize();
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const { category, textChannel } = await monitor.setupChannels(guild);

    // Запуск обновления статуса с защитой от перекрытия
    setIntervalAsync(
      () => monitor.updateServerStatus(guild, category, textChannel),
      CONFIG.UPDATE_INTERVAL
    );

    // Первоначальное обновление
    await monitor.updateServerStatus(guild, category, textChannel);
  } catch (error) {
    console.error('Bot startup failed:', error);
    process.exit(1);
  }
});

client.on('error', error => {
  console.error('Client error:', error);
});

process.on('unhandledRejection', error => {
  console.error('Unhandled rejection:', error);
});

client.login(process.env.TOKEN);