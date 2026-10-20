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
            console.log(`🚀 PROCESANDO UNIDAD: ${course.Name || course.NodeId}`);
            console.log(`========================================`);

            const tree = await this.uss.getCourseTree(course.NodeId, course.ParentNodeId);
            if (!tree.isSuccess) continue;
            
            const courseId = course.ParentNodeId; // Ej: 44845 (Intermediate 1)
            const unitId = course.NodeId;         // Ej: 44846 (Unit 1: Education)

            for (const unit of tree.data) {
                // Verificamos si tiene un Test sin nota (Grade === null) aunque figure como IsDone
                const testSection = unit.Children?.find(s => s.Name === "Test");
                const testMissingScore = testSection && (testSection.Grade === null || testSection.Grade === undefined || unit.Grade === null);

                if (!timeInjectionOnly && !testMissingScore && (unit.IsDone || unit.Progress === 1.0 || unit.Progress === 100)) {
                    console.log(`\n[✔] Lección: ${unit.Name} -> COMPLETADA CON NOTA (Saltando...)`);
                    continue;
                }

                console.log(`\n[*] Lección: ${unit.Name} (ID: ${unit.NodeId})`);
                const lessonCode = unit["Metadata"] ? unit["Metadata"]["Code"] : null;
                let contextText = "";
                
                if (lessonCode && !timeInjectionOnly) {
                    contextText = await ScraperUtil.getContext(lessonCode);
                    if (contextText) console.log(`    [#] Contexto extraído con éxito.`);
                }
                
                for (const section of unit.Children) {
                    const isTest = section.Name === "Test";
                    const needsTestRepair = isTest && (section.Grade === null || unit.Grade === null);

                    if (!timeInjectionOnly && !needsTestRepair && (section.IsDone || section.Progress === 1.0 || section.Progress === 100)) {
                        console.log(`  [✔] ${section.Name} -> Listo`);
                        continue;
                    }

                    const lessonSessionId = crypto.randomUUID();
                    const randomMinutes = Math.floor(Math.random() * (14 - 8 + 1)) + 8;

                    await this.uss.setTimeOnLesson(courseId, section.NodeId, lessonSessionId, "S", Date.now());
                    
                    if (timeInjectionOnly) {
                        console.log(`  [⏳] MODO FANTASMA: Simulando ${randomMinutes} min reales en "${section.Name}"...`);
                        for (let i = 0; i < randomMinutes; i++) {
                            await new Promise(r => setTimeout(r, 60000));
                            await this.uss.sendPing(lessonSessionId);
                            console.log(`    [-] Ping de actividad: Minuto ${i+1}/${randomMinutes} validado.`);
                        }
                    } else {
                        if (!isTest) {
                            console.log(`  [>] Completando: ${section.Name}`);
                            for (const task of section.Children) {
                                if (task.IsDone || task.Progress === 1.0) continue;
                                await this.uss.setSucessTask(courseId, task.NodeId);
                                await this.uss.sendPing(lessonSessionId);
                                await new Promise(r => setTimeout(r, 1000));
                            }
                        } else {
                            console.log(`  [!] Iniciando Oráculo para el Test completo...`);
                            if (!lessonCode) continue;

                            const testTasks = section.Children && section.Children.length > 0 
                                ? section.Children 
                                : [{ NodeId: section.NodeId, Metadata: { Code: lessonCode } }];

                            // Resolvemos TODAS las partes del Test y las enviamos en UN SOLO POST
                            await this.resolveFullTest(
                                unitId,         // 44846 (ID de la Unidad Padre)
                                unit.NodeId,    // 38 (ID de la Lección)
                                lessonCode,     // Ej: "i1rack"
                                testTasks,      // Array con las tareas [23875, 23876, ...]
                                contextText, 
                                lessonSessionId
                            );
                        }
                    }
                    await this.uss.setTimeOnLesson(courseId, section.NodeId, lessonSessionId, "E", Date.now());
                }
            }
        }
    }

    async resolveFullTest(unitId, lessonNodeId, lessonCode, testTasks, contextText, lessonSessionId) {
        try {
            const submitAnswer = [];
            let partCounter = 1;
            const startTime = Date.now();

            for (const task of testTasks) {
                const taskCode = task.Metadata?.Code ? task.Metadata.Code : lessonCode;
                
                // Obtenemos la pregunta de esta parte (ej: 23875 / i1rackt001)
                const res = await this.uss.getTestItem(taskCode, task.NodeId, lessonNodeId, partCounter);
                if (!res.isSuccess) {
                    console.log(`    [!] No se pudo obtener la parte ${partCounter} (${taskCode})`);
                    partCounter++;
                    continue;
                }

                const item = res.data.i || res.data.item || res.data;
                const questions = item.q || item.questions || [];
                const userAnswersForTask = [];

                for (const q of questions) {
                    const rawQuestion = q.qt || (typeof q.t === 'string' ? q.t : null) || q.d || "Select the best answer.";
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
                    userAnswersForTask.push({
                        qId: q.id,
                        aId: aIdArray
                    });
                    
                    console.log(`      [-] Parte ${partCounter} (ID: ${task.NodeId}) -> Respuesta elegida: ${finalAnswerId}`);
                }

                // Empaquetamos con el formato EXACTO que exige SaveUserTest
                submitAnswer.push({
                    iId: String(task.NodeId),              // "23875"
                    iCode: res.matchedCode,                // "i1rackt001"
                    iType: String(res.matchedType || "25"),// "25" o "23"
                    ua: userAnswersForTask
                });

                await this.uss.sendPing(lessonSessionId);
                await new Promise(r => setTimeout(r, 4000)); // Pausa entre preguntas
                partCounter++;
            }

            if (submitAnswer.length === 0) {
                console.log(`    [!] No se generaron respuestas para enviar en este Test.`);
                return;
            }

            const timeSpentMs = Math.max(Date.now() - startTime, 32000);
            const status = await this.uss.SaveUserTestV1(unitId, lessonNodeId, submitAnswer, timeSpentMs);
            
            if (status.isSuccess && status.data?.finalMark !== undefined) {
                console.log(`    [#] Test Guardado Oficialmente -> Nota Final (Last Test Score): ${status.data.finalMark}%`);
            } else {
                console.log(`    [!] Respuesta inesperada al guardar Test:`, status.data || status.error);
            }
        } catch (e) {
            console.log(`    [!] Error en Test:`, e.message);
        }
    }
}