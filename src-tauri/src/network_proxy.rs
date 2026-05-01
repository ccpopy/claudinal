use std::net::IpAddr;

use reqwest::Url;
use tokio::io::{copy_bidirectional, AsyncReadExt, AsyncWriteExt};
use tokio::net::{lookup_host, TcpListener, TcpStream};
use tracing::{error, warn};

use crate::error::{Error, Result};

#[derive(Clone)]
struct Socks5Config {
    host: String,
    port: u16,
    remote_dns: bool,
    username: Option<String>,
    password: Option<String>,
}

pub fn is_socks_proxy_url(raw: &str) -> bool {
    Url::parse(raw)
        .ok()
        .is_some_and(|url| matches!(url.scheme(), "socks5" | "socks5h"))
}

pub async fn start_http_connect_bridge(proxy_url: &str) -> Result<String> {
    let config = parse_socks5_config(proxy_url)?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let addr = listener.local_addr()?;
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let config = config.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_client(stream, config).await {
                            warn!("network proxy bridge request failed: {e}");
                        }
                    });
                }
                Err(e) => {
                    error!("network proxy bridge accept failed: {e}");
                    break;
                }
            }
        }
    });
    Ok(format!("http://{addr}"))
}

fn parse_socks5_config(raw: &str) -> Result<Socks5Config> {
    let url = Url::parse(raw).map_err(|e| Error::Other(format!("invalid proxy url: {e}")))?;
    let remote_dns = match url.scheme() {
        "socks5" => false,
        "socks5h" => true,
        other => {
            return Err(Error::Other(format!(
                "unsupported socks proxy scheme: {other}"
            )))
        }
    };
    let host = url
        .host_str()
        .map(str::to_string)
        .ok_or_else(|| Error::Other("socks proxy host required".into()))?;
    let port = url.port().unwrap_or(1080);
    let username = if url.username().is_empty() {
        None
    } else {
        Some(percent_decode(url.username())?)
    };
    let password = url.password().map(percent_decode).transpose()?;
    Ok(Socks5Config {
        host,
        port,
        remote_dns,
        username,
        password,
    })
}

async fn handle_client(mut client: TcpStream, config: Socks5Config) -> Result<()> {
    let header = read_header(&mut client).await?;
    let header_text = std::str::from_utf8(&header)
        .map_err(|e| Error::Other(format!("proxy request header utf8: {e}")))?;
    let request_line = header_text
        .lines()
        .next()
        .ok_or_else(|| Error::Other("proxy request missing request line".into()))?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| Error::Other("proxy request missing method".into()))?;
    let target = parts
        .next()
        .ok_or_else(|| Error::Other("proxy request missing target".into()))?;

    if !method.eq_ignore_ascii_case("CONNECT") {
        let body = b"Claudinal SOCKS bridge only supports HTTP CONNECT requests";
        let response = format!(
            "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        client.write_all(response.as_bytes()).await?;
        client.write_all(body).await?;
        return Err(Error::Other(format!(
            "unsupported proxy bridge method: {method}"
        )));
    }

    let mut upstream = connect_via_socks5(&config, target).await?;
    client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;
    let _ = copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}

async fn read_header(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(Error::Other("proxy client closed before header".into()));
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            return Ok(buf);
        }
        if buf.len() > 64 * 1024 {
            return Err(Error::Other("proxy request header too large".into()));
        }
    }
}

async fn connect_via_socks5(config: &Socks5Config, target: &str) -> Result<TcpStream> {
    let (host, port) = parse_connect_target(target)?;
    let mut stream = TcpStream::connect((config.host.as_str(), config.port))
        .await
        .map_err(|e| Error::Other(format!("connect socks proxy: {e}")))?;

    socks5_handshake(&mut stream, config).await?;
    let address = socks5_address(&host, port, config.remote_dns).await?;
    let mut request = Vec::with_capacity(8 + address.len());
    request.extend_from_slice(&[0x05, 0x01, 0x00]);
    request.extend_from_slice(&address);
    stream
        .write_all(&request)
        .await
        .map_err(|e| Error::Other(format!("socks connect request: {e}")))?;

    read_socks5_connect_response(&mut stream).await?;
    Ok(stream)
}

async fn socks5_handshake(stream: &mut TcpStream, config: &Socks5Config) -> Result<()> {
    let needs_auth = config.username.is_some();
    let methods: &[u8] = if needs_auth { &[0x00, 0x02] } else { &[0x00] };
    stream.write_all(&[0x05, methods.len() as u8]).await?;
    stream.write_all(methods).await?;

    let mut response = [0u8; 2];
    stream.read_exact(&mut response).await?;
    if response[0] != 0x05 {
        return Err(Error::Other("invalid socks version in handshake".into()));
    }
    match response[1] {
        0x00 => Ok(()),
        0x02 => socks5_username_password_auth(stream, config).await,
        0xff => Err(Error::Other(
            "socks proxy rejected available authentication methods".into(),
        )),
        method => Err(Error::Other(format!(
            "unsupported socks authentication method: {method}"
        ))),
    }
}

async fn socks5_username_password_auth(
    stream: &mut TcpStream,
    config: &Socks5Config,
) -> Result<()> {
    let username = config.username.as_deref().unwrap_or("");
    let password = config.password.as_deref().unwrap_or("");
    if username.len() > u8::MAX as usize || password.len() > u8::MAX as usize {
        return Err(Error::Other(
            "socks username/password must be <= 255 bytes".into(),
        ));
    }

    let mut auth = Vec::with_capacity(3 + username.len() + password.len());
    auth.push(0x01);
    auth.push(username.len() as u8);
    auth.extend_from_slice(username.as_bytes());
    auth.push(password.len() as u8);
    auth.extend_from_slice(password.as_bytes());
    stream.write_all(&auth).await?;

    let mut response = [0u8; 2];
    stream.read_exact(&mut response).await?;
    if response == [0x01, 0x00] {
        Ok(())
    } else {
        Err(Error::Other("socks username/password auth failed".into()))
    }
}

async fn socks5_address(host: &str, port: u16, remote_dns: bool) -> Result<Vec<u8>> {
    let mut address = Vec::new();
    if remote_dns {
        let host_bytes = host.as_bytes();
        if host_bytes.len() > u8::MAX as usize {
            return Err(Error::Other("socks target host too long".into()));
        }
        address.push(0x03);
        address.push(host_bytes.len() as u8);
        address.extend_from_slice(host_bytes);
    } else {
        let ip = match host.parse::<IpAddr>() {
            Ok(ip) => ip,
            Err(_) => lookup_host((host, port))
                .await
                .map_err(|e| Error::Other(format!("resolve socks target: {e}")))?
                .next()
                .map(|addr| addr.ip())
                .ok_or_else(|| Error::Other(format!("resolve socks target: {host}")))?,
        };
        match ip {
            IpAddr::V4(ip) => {
                address.push(0x01);
                address.extend_from_slice(&ip.octets());
            }
            IpAddr::V6(ip) => {
                address.push(0x04);
                address.extend_from_slice(&ip.octets());
            }
        }
    }
    address.extend_from_slice(&port.to_be_bytes());
    Ok(address)
}

async fn read_socks5_connect_response(stream: &mut TcpStream) -> Result<()> {
    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await?;
    if head[0] != 0x05 {
        return Err(Error::Other(
            "invalid socks version in connect response".into(),
        ));
    }
    if head[1] != 0x00 {
        return Err(Error::Other(format!(
            "socks connect failed: {}",
            socks5_reply_message(head[1])
        )));
    }

    match head[3] {
        0x01 => {
            let mut rest = [0u8; 6];
            stream.read_exact(&mut rest).await?;
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            let mut rest = vec![0u8; len[0] as usize + 2];
            stream.read_exact(&mut rest).await?;
        }
        0x04 => {
            let mut rest = [0u8; 18];
            stream.read_exact(&mut rest).await?;
        }
        atyp => {
            return Err(Error::Other(format!(
                "unsupported socks bind address type: {atyp}"
            )))
        }
    }
    Ok(())
}

fn parse_connect_target(target: &str) -> Result<(String, u16)> {
    if let Some(rest) = target.strip_prefix('[') {
        let (host, tail) = rest
            .split_once(']')
            .ok_or_else(|| Error::Other(format!("invalid CONNECT target: {target}")))?;
        let port = tail
            .strip_prefix(':')
            .ok_or_else(|| Error::Other(format!("CONNECT target port required: {target}")))?
            .parse::<u16>()
            .map_err(|e| Error::Other(format!("invalid CONNECT target port: {e}")))?;
        return Ok((host.to_string(), port));
    }
    let (host, port) = target
        .rsplit_once(':')
        .ok_or_else(|| Error::Other(format!("CONNECT target port required: {target}")))?;
    if host.is_empty() {
        return Err(Error::Other(format!("invalid CONNECT target: {target}")));
    }
    let port = port
        .parse::<u16>()
        .map_err(|e| Error::Other(format!("invalid CONNECT target port: {e}")))?;
    Ok((host.to_string(), port))
}

fn socks5_reply_message(code: u8) -> &'static str {
    match code {
        0x01 => "general failure",
        0x02 => "connection not allowed",
        0x03 => "network unreachable",
        0x04 => "host unreachable",
        0x05 => "connection refused",
        0x06 => "ttl expired",
        0x07 => "command not supported",
        0x08 => "address type not supported",
        _ => "unknown error",
    }
}

fn percent_decode(raw: &str) -> Result<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(Error::Other(format!("invalid percent escape: {raw}")));
            }
            let hi = hex_value(bytes[i + 1])
                .ok_or_else(|| Error::Other(format!("invalid percent escape: {raw}")))?;
            let lo = hex_value(bytes[i + 2])
                .ok_or_else(|| Error::Other(format!("invalid percent escape: {raw}")))?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| Error::Other(format!("percent decoded utf8: {e}")))
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
