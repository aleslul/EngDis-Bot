import axios from "axios";
import crypto from "crypto";

export class UssClient {
    constructor(baseUrl, token) {
        this.api = axios.create({
            baseURL: baseUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Origin': 'https://ed.engdis.com',
                'Referer': 'https://ed.engdis.com/',
                'Authorization': `Bearer ${token?.trim()}`
            }
        });
        
        // CORRECCIÓN: Los IDs de sesión y pestaña se generan UNA sola vez al abrir el bot
        this.userSessionId = crypto.randomUUID();
        this.tabId = crypto.randomUUID();
    }

    getStudentId() {
        try {
            const token = this.api.defaults.headers['Authorization'].split(' ')[1];
            const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
            return payload.nameid || payload.StudentId || payload.sub || "52322710087471";
        } catch (e) {
            return "52322710087471"; 
        }
    }

    async setTimeOnLesson(courseId, lessonId, lessonSessionId, status = "S", customTimestamp = null) {
        const payload = {
            StudentId: this.getStudentId(),
            LessonId: lessonId,
            CourseId: courseId,
            UserSessionId: this.userSessionId, // Usamos la sesión persistente
            TimeStamp: customTimestamp || Date.now(),
            TabId: this.tabId, // Usamos la pestaña persistente
            LessonSessionId: lessonSessionId,
            Status: status 
        };
        try {
            await this.api.post('Progress/SetTimeOnLesson/', payload);
        } catch (e) { }
    }

    async sendPing(lessonSessionId) {
        try {
            await this.api.put(`Ping/Ping?lessonSessionId=${lessonSessionId}`);
        } catch (e) { }
    }

    async getSpecificCourseProgress(courseId) {
        try {
        const { data } = await this.api.get(`CourseTree/GetCourseProgress/${courseId}`);
        return { isSuccess: true, data: data.CourseProgressTree.Children };
        } catch (err) {
        return { isSuccess: false, data: err.message };
        }
    }

    async getCourseTree(NodeId, ParentNodeId) {
        try {
        const { data } = await this.api.post(`CourseTree/GetUserNodeProgress/${ParentNodeId}`, [
            { ParticleId: NodeId, NodeType: 2, LockedNodes: null, particleHasProgress: true, lowestNodeType: 5 }
        ]);
        return { isSuccess: true, data: data[0].Children };
        } catch (err) {
        return { isSuccess: false };
        }
    }

    async setSucessTask(CourseId, ItemId) {
        try {
        const response = await this.api.post("Progress/SetProgressPerTask", { CourseId, ItemId });
        return { isSuccess: true, data: response.data };
        } catch (err) {
        return { isSuccess: false };
        }
    }

async getTestItem(code, nodeId, parentId, partCounter = null) {
        const ids = [nodeId, parentId];
        let suffixes = ["t001", "t01", "t0", ""];

        if (partCounter !== null) {
            const pad3 = String(partCounter).padStart(3, '0');
            const pad2 = String(partCounter).padStart(2, '0');

            // EXCLUSIVO para el número de parte actual (sin caer en "t001" por error)
            suffixes = [
                `t${pad3}`,   // Ej: i1rackt004
                `t${pad2}`,   // Ej: t04
                `t1${pad2}`,  // Ej: t104
                `t${partCounter}`
            ];
            if (partCounter === 1) suffixes.push("t0", "");
        }

        const itemTypes = ["25", "23", "24", "21", "20", "22", "15"];

        for (const id of ids) {
            for (const sfx of suffixes) {
                for (const iType of itemTypes) {
                    try {
                        const fullCode = `${code}${sfx}`;
                        const url = `practiceManager/GetItem/${id}/${fullCode}/${iType}/0/2/`;
                        const res = await this.api.get(url);
                        if (res.data && (res.data.i || res.data.questions)) {
                            return { 
                                isSuccess: true, 
                                data: res.data, 
                                matchedCode: fullCode, 
                                matchedType: iType 
                            };
                        }
                    } catch (e) {
                        continue; 
                    }
                }
            }
        }
        return { isSuccess: false };
    }
    
    async SaveUserTestV1(parentUnitId, lessonNodeId, answersArray, timeSpentMs = 28000) {
        try {
            // System.Int16 en C# soporta máximo 32,767. Limitamos entre 15000 y 32000.
            const safeInt16Time = Math.min(Math.max(Math.floor(timeSpentMs), 15000), 32000);
            const payload = {
                a: answersArray,
                t: safeInt16Time
            };
            const { data } = await this.api.post(`/UserTestV1/SaveUserTest/${parentUnitId}/${lessonNodeId}/true`, payload);
            return { isSuccess: true, data };
        } catch (e) {
            const serverError = e.response?.data ? JSON.stringify(e.response.data) : e.message;
            return { isSuccess: false, error: serverError };
        }
    }

    async getProgress() {
        try {
        const { data } = await this.api.get('CourseTree/GetDefaultCourseProgress');
        let value = Math.round(data["CourseProgressTree"]["Progress"] * 100);
        return [value, data["CourseProgressTree"]["Grade"]];
        } catch (err) {
        return [0, 0];
        }
    }
}