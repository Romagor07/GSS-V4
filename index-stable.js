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
const fs = require('fs');
const Gamedig = require('gamedig');
const axios = require('axios');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const servers = require('./config/servers.json');
const messagesPath = './data/messages.json';

// Конфигурация
const CATEGORY_NAME = '📶│МОНИТОРИНГ';
const TEXT_CHANNEL_NAME = '🛰️ статус серверов';
const UPDATE_INTERVAL = 60_000;
const PROJECT_INFO_ID = 'project_info_message';

// Загрузка сохраненных сообщений
let messageData = fs.existsSync(messagesPath)
  ? JSON.parse(fs.readFileSync(messagesPath, 'utf-8'))
  : {};

// порядок серверов
const SERVER_ORDER = [
  'Metrostroi #1',
  'Metrostroi #2',
  'SCP:SL', 
  'AlcoMine'  
];

// Упорядочиваем серверы
const orderedServers = SERVER_ORDER.map(name => {
  const server = servers.find(s => s.name === name);
  if (!server) {
    console.error(`Сервер ${name} не найден в конфигурации!`);
    return null;
  }
  return server;
}).filter(Boolean);

// ==================== Функции проверки серверов ====================

async function queryMetrostroiServer(ip, port) {
  try {
    const result = await Gamedig.query({
      type: 'garrysmod',
      host: ip,
      port: port,
      socketTimeout: 10000,  // Увеличили таймаут до 10 секунд
    });

    const playerList = result.players.map(p => p.name || 'Неизвестный игрок');

    return {
      online: true,
      players: result.players.length,
      maxplayers: result.maxplayers,
      map: result.map,
      playerList: playerList,
      raw: result
    };
  } catch (err) {
    console.error(`Metrostroi query error:`, err);
    return { online: false };
  }
}

async function querySCPServer() {
  try {
    const response = await axios.get('https://api2.vodka-pro.ru/status/scpsl', {
      timeout: 5000,
      headers: {
        'Cache-Control': 'no-cache',
        'Accept': 'application/json'
      }
    });

    console.log('SCP API Response:', response.data);

    // Валидация ответа
    if (!response.data || typeof response.data !== 'object') {
      throw new Error('Неверный формат ответа API');
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

async function queryMinecraftServer(ip, port) {
  try {
    const result = await Gamedig.query({
      type: 'minecraft',
      host: ip,
      port: port,
      socketTimeout: 15000,
      maxAttempts: 3,
      attemptTimeout: 10000
    });

    return {
      online: true,
      players: result.raw?.vanilla?.players?.length || result.players.length,
      maxplayers: result.raw?.vanilla?.maxplayers || result.maxplayers,
      raw: result
    };
  } catch (err) {
    console.error(`Minecraft query error:`, err);
    return { online: false };
  }
}

// ==================== Вспомогательные функции ====================

async function cleanupOldMessages(textChannel) {
  try {
    const messages = await textChannel.messages.fetch({ limit: 100 });
    const savedMessageIds = Object.values(messageData);
    
    for (const [id, message] of messages) {
      if (!savedMessageIds.includes(id) && message.author.id === client.user.id) {
        await message.delete().catch(console.error);
      }
    }
  } catch (err) {
    console.error('Ошибка при очистке сообщений:', err);
  }
}

async function updateProjectInfoMessage(textChannel) {
  const embed = new EmbedBuilder()
    .setTitle('📌 Наша коллекция сервера Metrostroi VP Norank ')
    .setDescription(`ㅤ
      [Ссылка на Steam Workshop](https://steamcommunity.com/sharedfiles/filedetails/?id=2903637092)
    `)
    .setColor('#5865F2')
    .setThumbnail('https://vodka-pro.ru/img/logo.png')
    .setFooter({ text: 'VODKA Project' });

  try {
    if (messageData[PROJECT_INFO_ID]) {
      try {
        const msg = await textChannel.messages.fetch(messageData[PROJECT_INFO_ID]);
        await msg.edit({ embeds: [embed] });
        return;
      } catch (err) {
        delete messageData[PROJECT_INFO_ID];
      }
    }

    const sent = await textChannel.send({ embeds: [embed] });
    messageData[PROJECT_INFO_ID] = sent.id;
    fs.writeFileSync(messagesPath, JSON.stringify(messageData, null, 2));
  } catch (err) {
    console.error('Ошибка при обновлении информации о проекте:', err);
  }
}

// ==================== Основная логика бота ====================

client.once('ready', async () => {
  console.log(`Бот запущен как ${client.user.tag}`);
  
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  let channels = await guild.channels.fetch();

  // Создание категории
  let category = channels.find(c => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME);
  if (!category) {
    category = await guild.channels.create({
      name: CATEGORY_NAME,
      type: ChannelType.GuildCategory
    });
    channels = await guild.channels.fetch();
  }

  // Создание голосовых каналов
  for (const srv of orderedServers) {
    let voiceChannel = channels.find(c => 
      c.type === ChannelType.GuildVoice && 
      c.name.includes(srv.name) && 
      c.parentId === category.id
    );
    
    if (!voiceChannel) {
      voiceChannel = await guild.channels.create({
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
    }
  }

  // Создание текстового канала
  let textChannel = messageData.textChannelId 
    ? await guild.channels.fetch(messageData.textChannelId).catch(() => null)
    : null;

  if (!textChannel) {
    textChannel = await guild.channels.create({
      name: TEXT_CHANNEL_NAME,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [{
        id: guild.roles.everyone,
        allow: [PermissionsBitField.Flags.ViewChannel],
        deny: [PermissionsBitField.Flags.SendMessages]
      }]
    });
    messageData.textChannelId = textChannel.id;
    fs.writeFileSync(messagesPath, JSON.stringify(messageData, null, 2));
  } else {
    await cleanupOldMessages(textChannel);
  }

  await updateProjectInfoMessage(textChannel);

  // Запуск обновления статуса
  const updateWithErrorHandling = async () => {
    try {
      await updateStatus(guild, category, textChannel);
    } catch (err) {
      console.error('Ошибка при обновлении статуса:', err);
    }
  };

  setInterval(updateWithErrorHandling, UPDATE_INTERVAL);
  updateWithErrorHandling();
});

async function updateStatus(guild, category, textChannel) {
  // Сначала очищаем старые сообщения
  await cleanupOldMessages(textChannel);

  // Затем последовательно обрабатываем каждый сервер
  for (const srv of orderedServers) {
    try {
      let online = false;
      let numplayers = 0;
      let maxplayers = srv.maxplayers || 20;
      let ipDisplay = `${srv.ip}:${srv.port}`;
      let serverName = srv.name;
      let metroResult, scpResult, mcResult;

      // Запрос статуса сервера
      try {
        switch (srv.type) {
          case 'garrysmod':
            metroResult = await queryMetrostroiServer(srv.ip, srv.port);
            online = metroResult.online;
            if (online) {
              numplayers = metroResult.players;
              maxplayers = metroResult.maxplayers;
            }
            break;

          case 'scp':
            scpResult = await querySCPServer();
            online = scpResult.online;
            numplayers = scpResult.players;
            maxplayers = scpResult.maxplayers;
            serverName = scpResult.serverName;
            break;

          case 'minecraft':
            mcResult = await queryMinecraftServer(srv.ip, srv.port);
            online = mcResult.online;
            if (online) {
              numplayers = mcResult.players;
              maxplayers = mcResult.maxplayers;
            }
            break;
        }
      } catch (err) {
        console.error(`Ошибка проверки ${srv.name}:`, err);
        online = false;
      }

      // Обновление голосового канала
      try {
        const voice = guild.channels.cache.find(
          c => c.type === ChannelType.GuildVoice && 
               c.name.includes(srv.name) && 
               c.parentId === category.id
        );
        
        if (voice) {
          const playersLabel = online ? `${numplayers}/${maxplayers}` : 'Offline';
          const newName = `${online ? '🟢' : '🔴'} ${serverName} (${playersLabel})`;
          const safeName = newName.length > 100 ? newName.substring(0, 97) + '...' : newName;
          
          await voice.setName(safeName);
        }
      } catch (err) {
        console.error(`Ошибка обновления голосового канала ${serverName}:`, err);
      }

      // Создание Embed сообщения
      const embed = new EmbedBuilder()
        .setTitle(`${online ? '🟢' : '🔴'} ${serverName}`)
        .setColor(online ? '#43B581' : '#F04747')
        .setTimestamp();

      // Настройки для разных типов серверов
      if (srv.type === 'garrysmod') {
        let playersFieldValue = 'Нет игроков онлайн';
        if (metroResult?.online && metroResult.playerList?.length > 0) {
          playersFieldValue = metroResult.playerList
            .slice(0, 20)
            .map((name, idx) => `${idx + 1}. ${name}`)
            .join('\n');
          
          if (metroResult.playerList.length > 20) {
            playersFieldValue += `\n...и ещё ${metroResult.playerList.length - 20}`;
          }
        }

        embed
          .setDescription('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
          .addFields(
            { name: '🌐 Адрес', value: `\`${ipDisplay}\``, inline: true },
            { name: '🔹 Статус', value: online ? 'Онлайн' : 'Оффлайн\смена карты', inline: true },
            { name: '👥 Игроки', value: `${numplayers}/${maxplayers}`, inline: true },
            { name: '🗺️ Карта', value: metroResult?.map || 'Неизвестно' },
            { name: '📋 Список игроков', value: playersFieldValue }
          );
          
        if (metroResult?.map && metroResult.map !== 'Unknown') {
          embed.setThumbnail(`https://dev.novanautilus.net/images/${metroResult.map.replace(/ /g, '_')}.jpg`);
        }
      }
      else if (srv.type === 'scp') {
        embed
          .setDescription('🔻 SCP: Secret Laboratory')
          .addFields(
            { name: '🌐 Адрес', value: `\`${ipDisplay}\``, inline: true },
            { name: '🔹 Статус', value: online ? 'Онлайн' : 'Оффлайн', inline: true },
            { name: '👥 Игроки', value: `${numplayers}/${maxplayers}`, inline: true }
          );
      }
      else if (srv.type === 'minecraft') {
        embed
          .setDescription('⛏️ Minecraft Server')
          .addFields(
            { name: '🌐 Адрес', value: `\`${ipDisplay}\``, inline: true },
            { name: '🔹 Статус', value: online ? 'Онлайн' : 'Оффлайн', inline: true },
            { name: '👥 Игроки', value: `${numplayers}/${maxplayers}`, inline: true }
          );
      }

      // Кнопка подключения
      let row = null;
      if (srv.type !== 'minecraft') {
        row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('Подключиться')
            .setStyle(ButtonStyle.Link)
            .setURL(srv.connect)
        );
      }

      // Обновление сообщения
      try {
        const key = srv.name;
        
        if (messageData[key]) {
          try {
            const msg = await textChannel.messages.fetch(messageData[key]);
            await msg.edit({ 
              embeds: [embed], 
              components: row ? [row] : [] 
            });
            continue;
          } catch (err) {
            delete messageData[key];
            fs.writeFileSync(messagesPath, JSON.stringify(messageData, null, 2));
          }
        }

        const sent = await textChannel.send({ 
          embeds: [embed], 
          components: row ? [row] : [] 
        });
        messageData[key] = sent.id;
        fs.writeFileSync(messagesPath, JSON.stringify(messageData, null, 2));
      } catch (err) {
        console.error(`Ошибка отправки сообщения для ${serverName}:`, err);
      }
    } catch (err) {
      console.error(`Ошибка при обработке сервера ${srv.name}:`, err);
    }
  }
}

client.login(process.env.TOKEN);