const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');


const CLICK_DB_PATH = path.join(__dirname, 'db', 'dhodksehoDB.xlsx');
const REL_SCORE_DB_PATH = path.join(__dirname, 'db', 'RelScoreDB.xlsx');

/**
 * clickDB.xlsx를 기반으로 알파벳순 관계쌍 점수 목록 생성
 * @returns {Array} [idA, idB, 점수] 목록 (idA < idB)
 */
function calcRelPairsScores() {
    console.log('1. 엑셀 파일에서 데이터 읽는 중...');
    const wb = XLSX.readFile(CLICK_DB_PATH);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws);
    console.log(`   - 총 ${data.length}개의 행 로드됨`);

    console.log('2. 참여자 ID 수집 중...');
    const ids = new Set();
    data.forEach(row => {
        if (row.fromUser) ids.add(row.fromUser.toString().trim());
        if (row.toUser) ids.add(row.toUser.toString().trim());
    });
    const participants = Array.from(ids).sort();
    console.log(`   - 총 ${participants.length}명의 참여자 추출됨: ${participants.join(', ')}`);

    console.log('3. 관계쌍 점수 계산 시작...');
    const results = [];

    for (let i = 0; i < participants.length - 1; i++) {
        for (let j = i + 1; j < participants.length; j++) {
            const fromUser = participants[i];
            const toUser = participants[j];

            // idA, idB 두 사람이 존재하는 행 찾기
            const pairRows = data.filter(row => {
                const a = row.fromUser.toString().trim();
                const b = row.toUser.toString().trim();
                return (a === fromUser && b === toUser) || (a === fromUser && b === toUser);
            });

            // 두 사람 간 점수 합산 또는 로직 정의
            // 예시로 양방향 점수 합산 평균을 구함
            let totalScore = 0;
            let count = 0;
            pairRows.forEach(row => {
                if (!isNaN(row.score)) {
                    totalScore += parseFloat(row.score);
                    count++;
                }
            });

            const avgScore = count > 0 ? totalScore / count : 0;

            results.push([fromUser, toUser, avgScore]);
            console.log(`   - 쌍: ${fromUser}, ${toUser} / 점수: ${avgScore}`);
        }
    }

    console.log(`   - 총 ${results.length}개의 관계쌍 점수 계산 완료`);
    return results;
}


/**
 * 결과를 RelScoreDB.xlsx에 저장 ([a, b, 점수] 목록)
 * @param {Array} pairsScores
 */

function savePairScores(pairsScores) {
    console.log('4. 결과를 RelScoreDB.xlsx에 저장 중...');

    // 1. 기존 파일 로드
    let existingData = [];
    if (fs.existsSync(REL_SCORE_DB_PATH)) {
        const oldWb = XLSX.readFile(REL_SCORE_DB_PATH);
        const oldWs = oldWb.Sheets[oldWb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(oldWs, { header: 1 });
        existingData = raw.slice(1); // 헤더 제외
    }

    // 2. 기존 데이터 Map으로 변환
    const scoreMap = new Map();
    existingData.forEach(([id1, id2, score]) => {
        const [a, b] = [id1, id2].sort();
        const key = `${a}-${b}`;
        scoreMap.set(key, score);
    });

    // 3. 새 점수 병합
    pairsScores.forEach(([id1, id2, newScore]) => {
        const [a, b] = [id1, id2].sort();
        const key = `${a}-${b}`;
        const existingScore = scoreMap.get(key);

        if (existingScore === undefined) {
            scoreMap.set(key, 0.5);
        } else if (existingScore === 0.0 && newScore > 0.0) {
            scoreMap.set(key, 0.5);
        } else if (existingScore === 0.5 && newScore === 1.0) {
            scoreMap.set(key, 1.0);
        }
    });

    // 4. Map → 배열 변환 후 정렬
    const updatedData = Array.from(scoreMap.entries()).map(([key, score]) => {
        const [idA, idB] = key.split('-');
        return [idA, idB, score];
    });

    updatedData.sort((a, b) => {
        if (a[0] !== b[0]) return a[0].localeCompare(b[0]);
        return a[1].localeCompare(b[1]);
    });

    // 5. 헤더 추가
    const finalData = [['idA', 'idB', 'score'], ...updatedData];

    // 6. 저장
    const ws = XLSX.utils.aoa_to_sheet(finalData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, REL_SCORE_DB_PATH);

    console.log(`   - 저장 완료: ${REL_SCORE_DB_PATH}`);
}


// 실행부

module.exports = { calcRelPairsScores, savePairScores };
