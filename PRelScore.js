const XLSX = require("xlsx");
const path = require("path");

// 파일 경로
const REL_SCORE_PATH = path.join(__dirname, 'db', "RelScoreDB.xlsx");
const P_REL_SCORE_PATH = path.join(__dirname, 'db', "PRelScoreDB.xlsx");

function calcPersonalRelScores() {
    // 1. 데이터 로드
    const wb = XLSX.readFile(REL_SCORE_PATH);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws);  // 헤더 기반 읽기
    console.log("RelScore.js의 12줄까지는 실행됨:", data);

    // 2. 참가자 추출
    const ids = new Set();
    data.forEach(row => {
        console.log('row:', row);
        if (row.idA && typeof row.idA === 'string') ids.add(row.idA.trim());
        if (row.idB && typeof row.idB === 'string') ids.add(row.idB.trim());
    });
    const participants = Array.from(ids).sort();
    console.log('participants:', participants);

    // 3. 개인 관계 점수 계산
    const results = [];
    participants.forEach(id => {
        let total = 0.0;
        let count = 0;

        data.forEach(row => {
            const a = row.idA && typeof row.idA === 'string' ? row.idA.trim() : null;
            const b = row.idB && typeof row.idB === 'string' ? row.idB.trim() : null;
            const score = parseFloat(row.score);

            if ((a === id || b === id) && !isNaN(score)) {
                total += score;
                count += 1;
            }
        });

        const avg = count > 0 ? total / count : 0.0;
        console.log(`참가자: ${id}, total: ${total}, count: ${count}, avg: ${avg}`);
        results.push([id, avg]);
    });

    console.log('results:', results);

    // 4. 결과 저장
    const newWb = XLSX.utils.book_new();
    const newWs = XLSX.utils.aoa_to_sheet([["ID", "Score"], ...results]);
    XLSX.utils.book_append_sheet(newWb, newWs, "Sheet1");
    XLSX.writeFile(newWb, P_REL_SCORE_PATH);

    console.log("PRelScorejs까진 됨:", P_REL_SCORE_PATH);
    return results;
}


module.exports = { calcPersonalRelScores };
