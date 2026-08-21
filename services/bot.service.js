import crypto from "crypto";
import { ScraperUtil } from "../utils/scraper.util.js";

export class BotService {
    constructor(ussClient, aiService) {
        this.uss = ussClient;
        this.ai = aiService;
    }

    async processCourses(courses, isToeic, timeInjectionOnly = false) {
        for (const course of courses) {
            console.log(`\n========================================`);
            console.log(`🚀 PROCESANDO CURSO/UNIDAD: ${course.Name || course.NodeId}`);
            console.log(`========================================`);

            const tree = await this.uss.getCourseTree(course.NodeId, course.ParentNodeId);
            if (!tree.isSuccess) continue;
            const courseId = course.ParentNodeId; 

            for (const unit of tree.data) {
                if (!timeInjectionOnly && (unit.IsDone || unit.Progress === 1.0 || unit.Progress === 100)) {
                    console.log(`\n[✔] Unidad: ${unit.Name} -> COMPLETADA (Saltando...)`);
                    continue;
                }

                console.log(`\n[*] Lección: ${unit.Name}`);
                const lessonCode = unit["Metadata"] ? unit["Metadata"]["Code"] : null;
                let contextText = "";
                
                if (lessonCode && !timeInjectionOnly) {
                    contextText = await ScraperUtil.getContext(lessonCode);
                    if (contextText) console.log(`    [#] Contexto extraído con éxito.`);
                }
                
                for (const section of unit.Children) {
                    if (!timeInjectionOnly && (section.IsDone || section.Progress === 1.0 || section.Progress === 100)) {
                        console.log(`  [✔] ${section.Name} -> Listo`);
                        continue;
                    }

                    // ⏳ PROTOCOLO DE TIEMPO ORGÁNICO
                    const lessonSessionId = crypto.randomUUID();
                    const randomMinutes = Math.floor(Math.random() * (16 - 8 + 1)) + 8; // Entre 8 y 16 minutos

                    // Iniciamos la lección (El servidor registra el inicio real)
                    await this.uss.setTimeOnLesson(courseId, section.NodeId, lessonSessionId, "S", Date.now());
                    
                    if (timeInjectionOnly) {
                        console.log(`  [⏳] MODO FANTASMA: Simulando ${randomMinutes} min reales en "${section.Name}"...`);
                        
                        // IDLE LOOP: Espera humana real para evadir la validación del servidor
                        for (let i = 0; i < randomMinutes; i++) {
                            await new Promise(r => setTimeout(r, 60000)); // Espera 60 segundos exactos
                            await this.uss.sendPing(lessonSessionId); // Avisa al servidor "sigo aquí"
                            console.log(`    [-] Ping de actividad: Minuto ${i+1}/${randomMinutes} validado.`);
                        }
                        
                    } else {
                        // LÓGICA NORMAL DE TAREAS Y TESTS
                        if (section.Name !== "Test") {
                            console.log(`  [>] Completando: ${section.Name}`);
                            for (const task of section.Children) {
                                if (task.IsDone || task.Progress === 1.0) continue;
                                await this.uss.setSucessTask(courseId, task.NodeId);
                                
                                await this.uss.sendPing(lessonSessionId);
                                await new Promise(r => setTimeout(r, 1000));
                            }
                        } else {
                            console.log(`  [!] Iniciando Oráculo para el Test...`);
                            if (!lessonCode) continue;

                            let partCounter = 1;
                            const testTasks = section.Children && section.Children.length > 0 ? section.Children : [{ NodeId: section.NodeId, Metadata: { Code: lessonCode } }];

                            for (const task of testTasks) {
                                if (task.IsDone || task.Progress === 1.0) {
                                    console.log(`    [✔] Parte ${partCounter} ya aprobada.`);
                                    partCounter++;
                                    continue;
                                }
                                const taskCode = task.Metadata?.Code ? task.Metadata.Code : lessonCode;
                                // CORRECCIÓN: Ahora enviamos el lessonSessionId como 6to parámetro
                                await this.resolveTest(taskCode, task.NodeId, courseId, contextText, partCounter, lessonSessionId);
                                partCounter++;
                            }
                        }
                    }
                    // Cerramos la lección
                    await this.uss.setTimeOnLesson(courseId, section.NodeId, lessonSessionId, "E", Date.now());
                }
            }
        }
    }

    // CORRECCIÓN: Agregamos lessonSessionId a los parámetros
    async resolveTest(code, nodeId, courseId, contextText, partCounter, lessonSessionId) {
        try {
            await this.uss.setSucessTask(courseId, nodeId); 
            await new Promise(r => setTimeout(r, 1000));

            const res = await this.uss.getTestItem(code, nodeId, courseId, partCounter);
            if (!res.isSuccess) return console.log(`    [!] Error: La USS no devolvió el test para ${code} (Parte ${partCounter})`);

            const item = res.data.i || res.data.item || res.data;
            const questions = item.q || item.questions;
            const submitAnswer = [];

            for (const q of questions) {
                const rawQuestion = q.qt || (typeof q.t === 'string' ? q.t : null) || q.d || "Context task";
                const preguntaTexto = rawQuestion.toString().replace(/<[^>]*>?/gm, '').trim();
                
                let rawOptions = [];
                if (q.al) q.al.forEach(blank => { if (blank.a) rawOptions.push(...blank.a); });
                if (item.d) rawOptions.push(...item.d); 
                if (q.d) rawOptions.push(...q.d);       

                const options = rawOptions.map(opt => ({
                    id: opt.id,
                    text: (opt.txt || opt.t || "").toString().replace(/<[^>]*>?/gm, '').trim()
                }));

                const idCorrecto = await this.ai.getAnswer(preguntaTexto, options, contextText);
                const finalAnswerId = ScraperUtil.parseAnswerId(idCorrecto, options);

                const aIdArray = q.al ? q.al.map(blank => [blank.id, finalAnswerId]) : [];
                submitAnswer.push({
                    iId: item.id, iCode: item.c, iType: item.t || 1,
                    ua: [{ qId: q.id, aId: aIdArray }]
                });            
                
                console.log(`      [-] Pregunta procesada. ID elegido: ${finalAnswerId}`);
                
                // CORRECCIÓN: Ping activado. Mientras el bot "piensa" 12s, le dice a la USS que sigue activo.
                await this.uss.sendPing(lessonSessionId);
                await new Promise(r => setTimeout(r, 12000)); 
            }

            const status = await this.uss.SaveUserTestV1(nodeId, courseId, submitAnswer);
            console.log(`    [#] Resultado -> ${status.data?.finalMark ? status.data.finalMark + "%" : "Enviada"}`);
        } catch (e) {
            console.log(`    [!] Error en Test:`, e.message);
        }
    }
}