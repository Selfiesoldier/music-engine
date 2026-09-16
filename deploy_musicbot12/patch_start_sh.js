import fs from 'fs';

const filePath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/start.sh';
let content = fs.readFileSync(filePath, 'utf8');

// Ensure unix line endings
content = content.replace(/\r\n/g, '\n');

// Replace python3 -u main.py & with tee to logs/bot.log
if (content.includes('python3 -u main.py &')) {
  content = content.replace(
    'python3 -u main.py &',
    'mkdir -p logs\npython3 -u main.py 2>&1 | tee -a logs/bot.log &'
  );
  console.log('Updated python3 invocation in start.sh with tee to logs/bot.log');
} else {
  console.log('python3 -u main.py & not found or already updated');
}

fs.writeFileSync(filePath, content, { encoding: 'utf8', newline: '\n' });
console.log('start.sh patch complete!');
