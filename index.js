// index.js
// 使用 'use strict' 模式确保代码质量
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

// =============================================================================
// 常量定义
// =============================================================================

const PTY_BUFFER_SIZE = 300e3; // 300,000 字符的缓冲区大小
const PORT = process.env.PORT || 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCRIPTS_DIR = process.env.SCRIPTS_DIR || path.join(__dirname, 'scripts');
const LOGS_DIR = process.env.LOGS_DIR || path.join(__dirname, 'logs');
const WORKSPACE = process.env.WORKSPACE || path.join(__dirname, 'workspace');

// =============================================================================
// 后端服务 (Backend Service)
// =============================================================================

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 用于存储所有活跃的 pty 进程
// 键是 pty 的 pid，值是 pty 实例和相关信息的对象
const ptys = {};
// 用于跟踪正在运行的脚本，确保单例执行
// 键是 'repoName/scriptName'，值是对应的 pid
const runningScripts = {};

// 确保必要的目录存在
if (!fs.existsSync(SCRIPTS_DIR)) {
    fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
    // 创建一些示例脚本用于演示
    const exampleRepoDir = path.join(SCRIPTS_DIR, 'project-a');
    if (!fs.existsSync(exampleRepoDir)) {
        fs.mkdirSync(exampleRepoDir);
    }
    fs.writeFileSync(path.join(exampleRepoDir, 'build.sh'), `#!/bin/bash\n# build.sh for project-a\necho "Building project-a..."\nfor i in {1..10}; do\n  echo "Build step $i/10"\n  sleep 1\ndone\necho "Project-a build complete!"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(exampleRepoDir, 'dev.sh'), `#!/bin/bash\n# dev.sh for project-a\necho "Starting dev server for project-a..."\necho "Base URL from dashboard: $BASE_URL"\ncount=0\nwhile true; do\n  echo "Dev server running... ($count)"\n  count=$((count+1))\n  sleep 2\ndone\n`, { mode: 0o755 });
}

// 确保日志目录存在
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * 格式化时间为 YYMMDDhhmmss 格式
 * @param {Date} date 
 * @returns {string}
 */
function formatTimeForLog(date) {
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

/**
 * 生成日志文件名
 * @param {string} nameWithoutSlash 
 * @param {Date} startTime 
 * @returns {string}
 */
function generateLogFileName(nameWithoutSlash, startTime) {
    const timeStr = formatTimeForLog(startTime);
    return `scripts-${nameWithoutSlash}-${timeStr}.log`;
}

/**
 * 管理缓冲区，确保不超过最大大小
 * @param {string} buffer 
 * @param {string} newData 
 * @returns {string}
 */
function manageBuffer(buffer, newData) {
    const combined = buffer + newData;
    if (combined.length > PTY_BUFFER_SIZE) {
        // 如果超过缓冲区大小，保留后面的部分
        return combined.slice(-PTY_BUFFER_SIZE);
    }
    return combined;
}


// 支持各种HTTP POST数据格式
app.use(express.json()); // 支持 application/json
app.use(express.urlencoded({ extended: true })); // 支持 application/x-www-form-urlencoded

/**
 * API: 列出所有可用的脚本
 * @route GET /api/scripts
 * @returns {Array} 脚本列表，格式为 { repoName, scriptName, path }
 */
app.get('/api/scripts', (req, res) => {
    try {
        const allScripts = [];
        
        // 1. 处理直接放在 SCRIPTS_DIR 下的脚本
        const directScripts = fs.readdirSync(SCRIPTS_DIR, { withFileTypes: true })
            .filter(dirent => !dirent.isDirectory() && dirent.name.endsWith('.sh') && !dirent.name.startsWith('.'))
            .map(dirent => ({
                repoName: '_root',
                scriptName: dirent.name.replace('.sh', ''),
                path: path.join(SCRIPTS_DIR, dirent.name),
                isDirectScript: true
            }));
        allScripts.push(...directScripts);
        
        // 2. 处理子目录中的脚本
        const repos = fs.readdirSync(SCRIPTS_DIR, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        const subdirScripts = repos.flatMap(repoName => {
            const repoDir = path.join(SCRIPTS_DIR, repoName);
            const workspaceRepoDir = path.join(WORKSPACE, repoName);
            
            // 检查对应的repoName文件夹是否在WORKSPACE下存在
            if (!fs.existsSync(workspaceRepoDir)) {
                console.warn(`Repository ${repoName} not found in WORKSPACE: ${workspaceRepoDir}`);
                return []; // 如果WORKSPACE下不存在对应的repo文件夹，则跳过这个repo的脚本
            }
            
            return fs.readdirSync(repoDir)
                .filter(file => file.endsWith('.sh'))
                .map(scriptName => ({
                    repoName,
                    scriptName: scriptName.replace('.sh', ''),
                    path: path.join(repoDir, scriptName),
                    isDirectScript: false
                }));
        });
        allScripts.push(...subdirScripts);
        
        res.json(allScripts);
    } catch (error) {
        console.error('Failed to list scripts:', error);
        res.status(500).json({ error: '无法列出脚本' });
    }
});

/**
 * API: 启动一个脚本
 * @route POST /api/scripts/:repoName/:scriptName/start
 * @param {string|string[]} req.body.arg - 传递给脚本的参数，可以是单个值或数组
 * @param {string|string[]} req.query.arg - 也可以通过查询字符串传递参数
 * @returns {Object} 包含新启动的 pty信息的对象
 * 
 * 支持的数据格式:
 * - application/json: {"arg": "value"} 或 {"arg": ["value1", "value2"]}
 * - application/x-www-form-urlencoded: arg=value1&arg=value2 或 arg[]=value1&arg[]=value2
 * - multipart/form-data: 表单数据
 */
app.post('/api/scripts/:repoName/:scriptName/start', (req, res) => {
    const { repoName, scriptName } = req.params;
    const scriptId = `${repoName}/${scriptName}`;
    
    // 获取多个arg参数，支持多种数据格式
    let args = [];
    
    // 从请求体中提取参数（支持JSON、表单、multipart等格式）
    if (req.body && req.body.arg) {
        args = Array.isArray(req.body.arg) ? req.body.arg : [req.body.arg];
    }
    
    // 如果没有从请求体获取到参数，尝试从查询字符串获取
    if (args.length === 0 && req.query.arg) {
        args = Array.isArray(req.query.arg) ? req.query.arg : [req.query.arg];
    }
    
    let scriptPath, workspaceRepoDir;
    
    // 处理直接脚本（repoName 为 _root）
    if (repoName === '_root') {
        scriptPath = path.join(SCRIPTS_DIR, `${scriptName}.sh`);
        workspaceRepoDir = WORKSPACE; // 直接脚本使用 WORKSPACE 作为工作目录
    } else {
        // 处理子目录中的脚本
        scriptPath = path.join(SCRIPTS_DIR, repoName, `${scriptName}.sh`);
        workspaceRepoDir = path.join(WORKSPACE, repoName);

        // 检查对应的repoName文件夹是否在WORKSPACE下存在
        if (!fs.existsSync(workspaceRepoDir)) {
            return res.status(404).json({ 
                error: `仓库文件夹未找到: ${repoName}`,
                message: `WORKSPACE下不存在对应的仓库文件夹: ${workspaceRepoDir}`
            });
        }
    }

    // 如果相同名字的脚本正在运行，先终止旧的
    if (runningScripts[scriptId]) {
        const oldPid = runningScripts[scriptId];
        const oldPtyInfo = ptys[oldPid];
        if (oldPtyInfo) {
            oldPtyInfo.pty.kill();
            // delete ptys[oldPid]; // 不删除旧的pty，保留历史记录
        }
        delete runningScripts[scriptId];
    }

    if (!fs.existsSync(scriptPath)) {
        return res.status(404).json({ error: '脚本未找到' });
    }

    const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
    // 构建完整的命令参数数组：脚本路径 + 用户提供的参数
    const commandArgs = [scriptPath, ...args];
    const ptyProcess = pty.spawn(shell, commandArgs, {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd: workspaceRepoDir, 
        env: {
            ...process.env,
            BASE_URL: BASE_URL,
            WORKSPACE: WORKSPACE,
        }
    });

    const pid = ptyProcess.pid;
    const startTime = new Date();
    const nameWithoutSlash = scriptId.replace(/\//g, '-');
    const logFileName = generateLogFileName(nameWithoutSlash, startTime);
    const logFilePath = path.join(LOGS_DIR, logFileName);

    // 创建日志文件流
    const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

    ptys[pid] = {
        pty: ptyProcess,
        repoName,
        scriptName,
        args: args, // 存储传递给脚本的参数
        startTime,
        buffer: '', // 初始化缓冲区
        logStream,
        logFilePath,
        isRunning: true
    };
    runningScripts[scriptId] = pid;

    console.log(`Started script: ${scriptId} with PID: ${pid}`);
    console.log(`Log file: ${logFilePath}`);

    // 监听 pty 输出并写入日志文件和缓冲区
    ptyProcess.on('data', (data) => {
        // 写入日志文件
        logStream.write(data);
        
        // 更新缓冲区
        ptys[pid].buffer = manageBuffer(ptys[pid].buffer, data);
    });

    ptyProcess.on('exit', () => {
        console.log(`Script ${scriptId} (PID: ${pid}) exited.`);
        
        // 标记为不再运行，但不删除 pty 信息
        ptys[pid].isRunning = false;
        delete runningScripts[scriptId];
        
        // 关闭日志流
        logStream.end();
    });

    res.status(201).json({
        pid,
        repoName,
        scriptName,
        args: args, // 返回传递给脚本的参数
        message: '脚本启动成功',
        logFile: logFileName
    });
});

/**
 * API: 终止一个正在运行的 pty 进程
 * @route POST /api/pty/:pid/stop
 */
app.post('/api/pty/:pid/stop', (req, res) => {
    const pid = parseInt(req.params.pid, 10);
    const ptyInfo = ptys[pid];

    if (ptyInfo) {
        if (ptyInfo.isRunning) {
            ptyInfo.pty.kill();
            res.json({ message: `进程 ${pid} 已终止` });
        } else {
            res.json({ message: `进程 ${pid} 已经结束` });
        }
    } else {
        res.status(404).json({ error: '进程未找到' });
    }
});

/**
 * API: 获取 pty 进程的缓冲区内容
 * @route GET /api/pty/:pid/buffer
 */
app.get('/api/pty/:pid/buffer', (req, res) => {
    const pid = parseInt(req.params.pid, 10);
    const ptyInfo = ptys[pid];

    if (ptyInfo) {
        res.json({
            buffer: ptyInfo.buffer || '',
            isRunning: ptyInfo.isRunning,
            logFile: ptyInfo.logFilePath ? path.basename(ptyInfo.logFilePath) : null,
            args: ptyInfo.args || [] // 返回传递给脚本的参数
        });
    } else {
        res.status(404).json({ error: '进程未找到' });
    }
});

/**
 * API: 手动销毁一个 pty 进程（包括历史记录）
 * @route DELETE /api/pty/:pid
 */
app.delete('/api/pty/:pid', (req, res) => {
    const pid = parseInt(req.params.pid, 10);
    const ptyInfo = ptys[pid];

    if (ptyInfo) {
        // 如果还在运行，先终止
        if (ptyInfo.isRunning) {
            ptyInfo.pty.kill();
        }
        
        // 关闭日志流
        if (ptyInfo.logStream) {
            ptyInfo.logStream.end();
        }
        
        // 从 runningScripts 中移除（如果存在）
        const scriptId = `${ptyInfo.repoName}/${ptyInfo.scriptName}`;
        if (runningScripts[scriptId] === pid) {
            delete runningScripts[scriptId];
        }
        
        // 完全删除 pty 信息
        delete ptys[pid];
        
        res.json({ message: `进程 ${pid} 已完全销毁` });
    } else {
        res.status(404).json({ error: '进程未找到' });
    }
});

/**
 * API: 流式获取进程输出内容
 * @route GET /api/pty/:pid/stream
 * @param {boolean} req.query.includeHistory - 是否包含历史buffer数据，默认为true
 * @param {boolean} req.query.sse - 是否使用SSE格式，默认为false（chunked格式）
 * @returns {Stream} 进程输出流
 */
app.get('/api/pty/:pid/stream', (req, res) => {
    const pid = parseInt(req.params.pid, 10);
    const ptyInfo = ptys[pid];
    
    if (!ptyInfo) {
        return res.status(404).json({ error: '进程未找到' });
    }
    
    // 解析查询参数
    const includeHistory = req.query.includeHistory !== 'false' && req.query.includeHistory !== '0'; // 默认为true
    const useSSE = req.query.sse === 'true'; // 默认为false，使用chunked
    
    // 设置响应头
    if (useSSE) {
        // Server-Sent Events 格式
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');
    } else {
        // Chunked 格式
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    
    // SSE 模式下的数据缓冲区，用于正确处理行分割
    let dataBuffer = '';
    
    // 发送历史buffer数据
    if (includeHistory && ptyInfo.buffer) {
        if (useSSE) {
            // SSE 格式：将历史数据按行分割发送
            const lines = ptyInfo.buffer.split('\n');
            const lastLine = lines.pop();
            dataBuffer = lastLine;
            lines.forEach((line) => {
                if (line) {
                    res.write(`data: ${line.replace(/\r/g, '')}\n\n`);
                }
            });
        } else {
            // Chunked 格式：直接发送历史数据
            res.write(ptyInfo.buffer);
        }
    }
    
    // 如果进程已经结束，发送结束标记并关闭连接
    if (!ptyInfo.isRunning) {
        const endMessage = '\r\n[进程已结束]\r\n';
        if (useSSE) {
            res.write(`data: [进程已结束]\n\n`);
            res.write(`event: close\ndata: Process finished\n\n`);
        } else {
            res.write(endMessage);
        }
        res.end();
        return;
    }
    
    const ptyProcess = ptyInfo.pty;
    
    // 创建数据处理函数
    const onDataHandler = (data) => {
        try {
            if (useSSE) {
                // SSE 格式：使用缓冲区处理行分割
                dataBuffer += data.toString();
                if (dataBuffer.includes('\n')) {
                    const lines = dataBuffer.split('\n');
                    const lastLine = lines.pop();
                    dataBuffer = lastLine;
                    lines.forEach((line) => {
                        if (line) {
                            res.write(`data: ${line.replace(/\r/g, '')}\n\n`);
                        }
                    });
                }
            } else {
                // Chunked 格式：直接发送数据
                res.write(data);
            }
        } catch (err) {
            console.error('Error sending data to stream:', err);
            cleanup();
        }
    };
    
    // 进程退出处理函数
    const onExitHandler = () => {
        console.log(`Stream for PID ${pid} ended: process exited`);
        try {
            if (useSSE) {
                // 发送剩余的缓冲区数据
                if (dataBuffer) {
                    res.write(`data: ${dataBuffer.replace(/\r/g, '')}\n\n`);
                }
                res.write(`event: close\ndata: Process finished\n\n`);
            } else {
                res.write('\r\n[进程已结束]\r\n');
            }
            res.end();
        } catch (err) {
            console.error('Error ending stream:', err);
        }
        cleanup();
    };
    
    // 清理函数
    const cleanup = () => {
        if (ptyProcess) {
            ptyProcess.removeListener('data', onDataHandler);
            ptyProcess.removeListener('exit', onExitHandler);
        }
    };
    
    // 监听进程输出和退出事件
    ptyProcess.on('data', onDataHandler);
    ptyProcess.on('exit', onExitHandler);
    
    // 客户端断开连接时的清理
    req.on('close', () => {
        console.log(`Stream client disconnected from PID: ${pid}`);
        cleanup();
    });
    
    req.on('error', (err) => {
        console.error(`Stream error for PID ${pid}:`, err);
        cleanup();
    });
});

/**
 * API: 列出所有 pty 进程（包括已结束的）
 * @route GET /api/pty
 * @returns {Array} pty 列表
 */
app.get('/api/pty', (req, res) => {
    const allPtys = Object.entries(ptys).map(([pid, info]) => ({
        pid: parseInt(pid, 10),
        repoName: info.repoName,
        scriptName: info.scriptName,
        args: info.args || [], // 返回传递给脚本的参数
        startTime: info.startTime,
        isRunning: info.isRunning,
        bufferSize: info.buffer ? info.buffer.length : 0,
        logFile: info.logFilePath ? path.basename(info.logFilePath) : null
    }));
    res.json(allPtys);
});


// WebSocket 连接处理
wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `ws://${req.headers.host}`);
    const pid = parseInt(url.searchParams.get('pid'), 10);
    const ptyInfo = ptys[pid];

    if (!ptyInfo) {
        console.error(`WebSocket connection rejected: No pty found for PID ${pid}`);
        ws.send(JSON.stringify({ error: `PID 为 ${pid} 的进程不存在。` }));
        ws.close();
        return;
    }

    console.log(`WebSocket connected to PID: ${pid}`);

    // 如果 pty 已经结束，发送缓冲区内容
    if (!ptyInfo.isRunning) {
        if (ptyInfo.buffer) {
            ws.send(ptyInfo.buffer);
        }
        ws.send('\r\n[进程已结束，显示历史记录]\r\n');
        // 不关闭连接，让用户查看历史记录
        // 但忽略所有来自客户端的输入
        ws.on('message', (message) => {
            // 忽略已结束进程的输入
            console.log(`Ignoring input for completed process PID: ${pid}`);
        });
        return;
    }

    const ptyProcess = ptyInfo.pty;

    // 发送缓冲区中的历史内容
    if (ptyInfo.buffer) {
        ws.send(ptyInfo.buffer);
    }

    // 将 pty 的输出转发到 WebSocket 客户端
    const onDataHandler = (data) => {
        try {
            ws.send(data);
        } catch (err) {
            console.error('Error sending data to WebSocket:', err);
        }
    };
    ptyProcess.on('data', onDataHandler);

    // 接收来自 WebSocket 客户端的输入并写入 pty
    ws.on('message', (message) => {
        if (ptyInfo.isRunning) {
            ptyProcess.write(message.toString());
        }
    });

    // 连接关闭时的清理工作
    ws.on('close', () => {
        console.log(`WebSocket disconnected from PID: ${pid}`);
        // 移除监听器，防止内存泄漏
        if (ptyInfo.isRunning) {
            ptyProcess.removeListener('data', onDataHandler);
        }
    });
});


// =============================================================================
// 前端应用 (Frontend Application)
// =============================================================================

// 提供前端静态文件
app.use(express.static(path.join(__dirname, 'static')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
});


// =============================================================================
// 启动服务器
// =============================================================================
if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`🚀 Dashboard server is running at ${BASE_URL}`);
        console.log(`➡️  Scripts directory: ${SCRIPTS_DIR}`);
    });
}

// 导出 app 供测试使用
module.exports = { app, server };

