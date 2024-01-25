registerPlugin({
    name: 'Spotify Playlist to YouTube',
    version: '1.0.1',
    description: 'Adds songs from Spotify to queue',
    author: 'sruusk',
    backends: ['ts3', 'discord'],
    requiredModules: ["http"],
    vars: [
        {
            name: 'youtubeApiKey',
            title: 'YouTube API Key',
            type: 'string'
        },
        {
            name: 'spotifyClientId',
            title: 'Spotify Client ID',
            type: 'string'
        },
        {
            name: 'spotifyClientSecret',
            title: 'Spotify Client Secret',
            type: 'string'
        },
        {
            name: 'playlistLengthLimit',
            title: 'Playlist length limit',
            type: 'number'
        },
        {
            name: 'allowedGroups',
            title: 'Allowed group Ids who are allowed to use the "!spotify" command',
            type: 'array',
            vars: [
                {
                    name: 'group',
                    type: 'string',
                    indent: 2,
                    placeholder: 'Group name or id'
                }
            ]
        }
    ]
}, (_, config) => {
    const engine = require('engine');
    const store = require('store');
    const event = require('event');
    const helpers = require('helpers');
    const media = require('media');
    const http = require('http');
    const format = require('format');
    const { youtubeApiKey, spotifyClientId, spotifyClientSecret, playlistLengthLimit, allowedGroups } = config;

    const makeRequest = (url) => {
        return new Promise((resolve, reject) => {
            getSpotifyAccessToken().then((accessToken) => {
                http.simpleRequest({
                    method: "GET",
                    url: url,
                    headers: {
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${ accessToken }`
                    },
                    timeout: 10000
                }, (err, response) => {
                    if(response.statusCode !== 200) {
                        engine.log(`Received invalid status from spotify: ${ response.statusCode }`);
                        reject(`Received invalid status from spotify: ${ response.statusCode } ${err}`);
                    }
                    else resolve(JSON.parse(response.data));
                });
            }).catch((err) => { reject(err); });
        });
    };
    const getPlaylistTracks = (playlistId) => {
        return new Promise(async (resolve, reject) => {
            const playlistUrl = `https://api.spotify.com/v1/playlists/${ playlistId }/tracks`;
            const { items } = await makeRequest(playlistUrl).catch((err) => { reject(err); });
            const tracks = items.filter((item) => {
                return !!(item && item.track && item.track.name && item.track.artists && item.track.artists.length > 0);
            }).map((item) => {
                const { track } = item;
                const { name, artists } = track;
                const artist = artists[0].name;
                return { name, artist };
            });
            resolve(tracks);
        });
    };

    const getAlbumTracks = (albumId) => {
        return new Promise(async (resolve, reject) => {
            const albumUrl = `https://api.spotify.com/v1/albums/${ albumId }/tracks`;
            const { items } = await makeRequest(albumUrl).catch((err) => { reject(err); });
            const tracks = items.filter((item) => {
                return !!(item && item.name && item.artists && item.artists.length > 0);
            }).map((item) => {
                const { name, artists } = item;
                const artist = artists[0].name;
                return { name, artist };
            });
            resolve(tracks);
        });
    };

    const getArtistTopTracks = (artistId) => {
        return new Promise(async (resolve, reject) => {
            const artistUrl = `https://api.spotify.com/v1/artists/${ artistId }/top-tracks?market=US`;
            const response = await makeRequest(artistUrl).catch((err) => { reject(err); });
            const tracks = response.tracks.filter((item) => {
                return !!(item && item.name && item.artists && item.artists.length > 0);
            }).map((item) => {
                const { name, artists } = item;
                const artist = artists[0].name;
                return { name, artist };
            });
            resolve(tracks);
        });
    };

    const getTrack = (trackId) => {
        return new Promise(async (resolve, reject) => {
            const trackUrl = `https://api.spotify.com/v1/tracks/${ trackId }`;
            const { name, artists } = await makeRequest(trackUrl).catch((err) => { reject(err); });
            const artist = artists[0].name;
            resolve({ name, artist });
        });
    };

    const getSpotifyAccessToken = () => {
        return new Promise((resolve, reject) => {
            if(store.get('spotifyAccessTokenExpires') > Date.now() + 5000) {
                resolve(store.get('spotifyAccessToken'));
            }
            http.simpleRequest({
                method: "POST",
                url: "https://accounts.spotify.com/api/token",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: `grant_type=client_credentials&client_id=${ spotifyClientId }&client_secret=${ spotifyClientSecret }`,
                timeout: 2000
            }, (error, response) => {
                if(response.statusCode != 200) {
                    engine.log(`Received invalid status from spotify auth: ${ response.statusCode }`);
                    reject(`Received invalid status from spotify auth: ${ response.statusCode } ${error}`);
                }
                else {
                    const token = JSON.parse(response.data);
                    store.set("spotifyAccessToken", token.access_token);
                    store.set("spotifyAccessTokenExpires", Date.now() + token.expires_in * 1000);
                    // Check system time against token expiration
                    if(store.get('spotifyAccessTokenExpires') < Date.now()) {
                        engine.log(`Invalid system time ${new Date()}, ${store.get('spotifyAccessTokenExpires')}, ${token}`);
                        reject(`Invalid system time ${new Date()}, ${store.get('spotifyAccessTokenExpires')}`);
                    }
                    else resolve(token.access_token);
                }
            });
        });
    };

    const getYouTubeVideoId = (name, artist) => {
        return new Promise((resolve, reject) => {
            http.simpleRequest({
                method: "GET",
                url: `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=1&q=${ encodeURIComponent(`${ name } ${ artist }`) }&type=video&key=${ youtubeApiKey }`,
                timeout: 10000
            }, (err, response) => {
                if(response.statusCode !== 200) reject(`Got response ${ response.statusCode } from YouTube, ${ err }`);
                else {
                    const { items } = JSON.parse(response.data);
                    if(items.length === 0) reject("No video found");
                    else {
                        const { id } = items[0];
                        resolve(id.videoId);
                    }
                }
            });
        });
    };

    const hasPermission = (client) => {
        if(!allowedGroups || allowedGroups.length === 0) return true;
        const clientServerGroups = client.getServerGroups();
        for(const serverGroup of clientServerGroups) {
            if(allowedGroups.includes(serverGroup.id())) return true;
        }
        return false;
    };

    const addTracksToQueue = (tracks) => {
        let timeout = 0;
        tracks.forEach((track) => {
            setTimeout(() => {
                getYouTubeVideoId(track.name, track.artist).then((videoId) => {
                    try {
                        media.enqueueYt(`https://www.youtube.com/watch?v=${ videoId }`);
                    } catch(e) {
                        engine.log(`Error while adding song "${ track.name } - ${ track.artist }" to queue: ${ e }`);
                    }
                }).catch((err) => {
                    engine.log(`Error while getting video id for "${ track.name } - ${ track.artist }": ${ err }`);
                });
            }, timeout);
            timeout += 20000;
        });
    };

    event.on('chat', ({ text, channel, client }) => {
        const source = channel ? channel : client;
        if(text.startsWith("!spotify")) {
            if(!hasPermission(client)) {
                source.chat("You don't have permission to use this command");
                return;
            }

            let spotifyLink = text.split(" ")[1];
            if(!spotifyLink) {
                source.chat("Usage: !spotify <spotifyLink>");
                return;
            }

            // Playlist
            // https://open.spotify.com/playlist/16tgYAtx5qgp3Eunt8nhc1?si=df8037aa873740bd&pt=f99f88976a2632e442c27c4693300274
            // Album
            // https://open.spotify.com/album/1H81jGoWeLI8ufq42GfDPn?si=hN1h6udCTC-XPNtcuQweBg
            // Song
            // https://open.spotify.com/track/5jgOuz0QrTGPusWcWvkdsp?si=2591125675a54d75

            id = spotifyLink.split('[/URL]').shift().split('/').pop().split('?').shift().trim();

            if(spotifyLink.includes("playlist")) {
                getPlaylistTracks(id).then((tracks) => {
                    if(tracks.length > playlistLengthLimit) {
                        source.chat(`Playlist is too long, max length is ${ playlistLengthLimit }`);
                        return;
                    }
                    addTracksToQueue(tracks);
                    source.chat("Adding " + tracks.length + " songs to queue");
                }).catch((err) => {
                    engine.log(`Error while getting playlist tracks: ${ err }, id: ${ id }`);
                    source.chat(`Error while getting playlist tracks: ${ err }, id: ${ id }`);
                });
            } else if(spotifyLink.includes("album")) {
                getAlbumTracks(id).then((tracks) => {
                    if(tracks.length > playlistLengthLimit) {
                        source.chat(`Album is too long, max length is ${ playlistLengthLimit }`);
                        return;
                    }
                    addTracksToQueue(tracks);
                    source.chat("Adding " + tracks.length + " songs to queue");
                }).catch((err) => {
                    engine.log(`Error while getting album tracks: ${ err }, id: ${ id }`);
                    source.chat(`Error while getting album tracks: ${ err }, id: ${ id }`);
                });
            } else if(spotifyLink.includes("track")) {
                getTrack(id).then((track) => {
                    addTracksToQueue([track]);
                    source.chat(`Adding ${ track.name } by ${ track.artist } to queue`);
                }).catch((err) => {
                    engine.log(`Error while getting track: ${ err }, id: ${ id }`);
                    source.chat(`Error while getting track: ${ err }, id: ${ id }`);
                });
            } else if(spotifyLink.includes("artist")) {
                getArtistTopTracks(id).then((tracks) => {
                    addTracksToQueue(tracks);
                    source.chat(`Adding ${ tracks.length } songs from ${ tracks[0].artist } to queue`);
                }).catch((err) => {
                    engine.log(`Error while getting artist top tracks: ${ err }, id: ${ id }`);
                    source.chat(`Error while getting artist top tracks: ${ err }, id: ${ id }`);
                });
            } else {
                source.chat("Unsupported link")
            }

        }
    });
});
