# WebFetch/WebSearch 自动代理重试功能设计

## 需求背景
当 WebFetch 或 WebSearch 因网络问题失败时（connection timeout, connection refused等），自动检测本地是否有可用的 VPN/代理端口，如果有则通过代理重试请求。

## 设计方案

### 1. 检测逻辑
当 HTTP 请求失败时（ureq 返回 Error），检测本地常见代理端口：

**常见端口列表**：
- `127.0.0.1:1080` - SOCKS5（Shadowsocks 默认）
- `127.0.0.1:7890` - HTTP/SOCKS5（Clash for Windows 默认）
- `127.0.0.1:7891` - HTTP/SOCKS5（Clash 备用端口）
- `127.0.0.1:10809` - HTTP（V2RayN 默认）
- `127.0.0.1:10808` - SOCKS5（V2RayN 默认）
- `127.0.0.1:9050` - SOCKS5（Tor 默认）
- `127.0.0.1:8118` - HTTP（Privoxy 默认）
- `127.0.0.1:1087` - SOCKS5（ClashX macOS 默认）

### 2. 检测方式
简单 TCP 连接测试（非常快，每个端口 < 100ms）：
```rust
fn detect_proxy_port(port: u16) -> Option<ProxyConfig> {
    use std::net::TcpStream;
    use std::time::Duration;
    
    let addr = format!("127.0.0.1:{}", port);
    if TcpStream::connect_timeout(&addr.parse().ok()?, Duration::from_millis(50)).is_ok() {
        // 根据端口猜测协议类型
        let protocol = match port {
            1080 | 10808 | 9050 | 1087 => ProxyProtocol::Socks5,
            7890 | 7891 => ProxyProtocol::Http, // Clash 支持 HTTP
            10809 | 8118 => ProxyProtocol::Http,
            _ => ProxyProtocol::Http, // 默认尝试 HTTP
        };
        Some(ProxyConfig { port, protocol })
    } else {
        None
    }
}
```

### 3. 重试策略

```rust
fn try_with_auto_proxy_retry<F>(make_request: F) -> Result<Response>
where
    F: Fn(Option<&ProxyConfig>) -> Result<Response>
{
    // 1. 首先直连尝试
    match make_request(None) {
        Ok(response) => return Ok(response),
        Err(err) => {
            // 只有在连接失败的情况下才尝试代理
            if !is_connection_error(&err) {
                return Err(err);
            }
            eprintln!("Direct connection failed: {}, attempting proxy retry...", err);
        }
    }
    
    // 2. 检测可用代理端口
    const PROXY_PORTS: &[u16] = &[7890, 1080, 10809, 10808, 7891, 1087, 9050, 8118];
    let available_proxies: Vec<_> = PROXY_PORTS.iter()
        .filter_map(|&port| detect_proxy_port(port))
        .collect();
    
    if available_proxies.is_empty() {
        return Err(anyhow!("No proxy found; direct connection failed"));
    }
    
    // 3. 依次尝试每个代理
    for proxy in &available_proxies {
        match make_request(Some(proxy)) {
            Ok(response) => {
                eprintln!("Success via proxy {}:{} ({})", 
                    "127.0.0.1", proxy.port, proxy.protocol);
                return Ok(response);
            }
            Err(err) => {
                eprintln!("Proxy {}:{} failed: {}", "127.0.0.1", proxy.port, err);
                continue;
            }
        }
    }
    
    Err(anyhow!("All proxy attempts failed"))
}
```

### 4. ureq 代理配置

ureq 支持通过 `Proxy` 配置代理：

```rust
use ureq::Proxy;

fn make_request_with_proxy(url: &str, proxy: Option<&ProxyConfig>) -> Result<Response> {
    let mut agent_builder = ureq::AgentBuilder::new();
    
    if let Some(proxy_cfg) = proxy {
        let proxy_url = match proxy_cfg.protocol {
            ProxyProtocol::Http => format!("http://127.0.0.1:{}", proxy_cfg.port),
            ProxyProtocol::Socks5 => format!("socks5://127.0.0.1:{}", proxy_cfg.port),
        };
        
        agent_builder = agent_builder.proxy(
            Proxy::new(proxy_url)
                .context("Failed to create proxy")?
        );
    }
    
    let agent = agent_builder.build();
    
    let response = agent
        .get(url)
        .set("User-Agent", "Magenta-WebFetch/0.1")
        .call()
        .map_err(|e| anyhow!("Request failed: {}", e))?;
    
    Ok(response)
}
```

### 5. 集成到现有代码

需要修改以下函数：
- `tool_read_url()` - WebFetch
- `try_duckduckgo_search()` - WebSearch DuckDuckGo
- `try_bing_search()` - WebSearch Bing

每个函数都包装为：
```rust
fn tool_read_url(input: ReadUrlInput) -> Result<String> {
    let url = normalize_url(&input.url)?;
    
    let response = try_with_auto_proxy_retry(|proxy| {
        make_url_request(&url, proxy)
    })?;
    
    // ... 后续处理保持不变
}
```

## 实现文件位置

- 主实现：`/Users/mjm/Magenta3/harness/modules/tools/read/magenta/process-tools/src/main.rs`
- 编译产物：需要重新编译并复制到 `dist/` 目录
- 工具配置：`web-fetch.toml` 和 `web-search/*.toml`

## 优势

1. **零配置**：无需用户手动设置代理，自动检测
2. **快速检测**：TCP 连接测试每个端口 < 50ms，总检测时间 < 500ms
3. **智能回退**：直连失败才尝试代理，不影响正常网络
4. **广泛兼容**：支持主流代理工具（Clash、V2Ray、Shadowsocks、Tor等）
5. **信息透明**：通过 stderr 输出代理使用情况，便于调试

## 潜在问题

1. **安全性**：只检测 localhost 端口，不存在安全风险
2. **性能**：增加 < 500ms 的代理检测开销（仅在直连失败时）
3. **误判**：端口被其他服务占用的情况（通过实际请求验证）

## 下一步

1. 实现 `detect_proxy_port()` 和 `try_with_auto_proxy_retry()`
2. 修改 `tool_read_url()`、`try_duckduckgo_search()`、`try_bing_search()`
3. 测试各种场景（直连成功、直连失败+代理成功、全失败）
4. 编译并部署到 dist 目录
