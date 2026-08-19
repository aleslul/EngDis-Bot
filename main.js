import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { UssClient } from './api/uss.client.js';
import { AiService } from './services/ai.service.js';
import { BotService } from './services/bot.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let win;

function createWindow() {
    win = new BrowserWindow({
        width: 900,
        height: 750,
        webPreferences: {
        nodeIntegration: true,
        contextIsolation: false 
        },
        autoHideMenuBar: true
    });

    win.loadFile('index.html');
}

app.whenReady().then(createWindow);

// EL TRUCO MAESTRO: Interceptamos la consola de Node para enviarla al Frontend
const originalLog = console.log;
console.log = (...args) => {
    originalLog(...args); // Mantiene el log oculto por si lo necesitamos
    if (win && win.webContents) {
        // Si el texto tiene error o éxito, le ponemos color, sino va gris
        let text = args.join(' ');
        let color = '#cccccc';
        if (text.includes('[!]')) color = '#ff4444';
        if (text.includes('[✔]') || text.includes('[#]')) color = '#00ff00';
        if (text.includes('🚀')) color = '#0078D7';
        
        win.webContents.send('bot-log', { text, color });
    }
};

// EL PUENTE IPC: Escuchando la orden del Frontend
ipcMain.on('start-bot', async (event, config) => {
    try {
        const { token, geminiKey, selectedLevel, includeToeic } = config;
        const baseUrl = "https://edwebservices.engdis.com/api/";

        // Inicializamos los servicios con las credenciales de la ventana
        const ussClient = new UssClient(baseUrl, token);
        const aiService = new AiService(geminiKey);
        const botService = new BotService(ussClient, aiService);

        // Mapeo automático de IDs según el nivel
        let targetCourseId = selectedLevel === 'basic3' ? 44205 : 44845;
        let toeicCourseId = selectedLevel === 'basic3' ? 1547470 : 1548014;

        console.log(`\n[*] Validando token en la USS...`);
        const resMain = await ussClient.getSpecificCourseProgress(targetCourseId);
        
        if (!resMain.isSuccess) {
            console.log("[!] Error crítico: USS Token inválido, expirado, o no estás inscrito en ese nivel.");
            event.reply('bot-finish');
            return;
        }

        // 1. Procesar General English
        const coursesMain = resMain.data.map(i => ({ NodeId: i.NodeId, ParentNodeId: i.ParentNodeId, Name: i.Name }));
        await botService.processCourses(coursesMain, false);

        // 2. Procesar TOEIC (Si el usuario marcó la casilla)
        if (includeToeic) {
            console.log(`\n[*] Iniciando módulo TOEIC...`);
            const resToeic = await ussClient.getSpecificCourseProgress(toeicCourseId);
            if (resToeic.isSuccess) {
                const coursesToeic = resToeic.data.map(i => ({ NodeId: i.NodeId, ParentNodeId: i.ParentNodeId, Name: i.Name }));
                await botService.processCourses(coursesToeic, true);
            } else {
                console.log("[!] No se pudo acceder al TOEIC de este nivel.");
            }
        }

        console.log("\n========================================");
        console.log("[#] TODAS LAS TAREAS COMPLETADAS CON ÉXITO");
        console.log("========================================");
        
        event.reply('bot-finish'); // Le avisamos al frontend que terminamos

    } catch (error) {
        console.log(`[!] Error crítico del sistema: ${error.message}`);
        event.reply('bot-finish');
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});