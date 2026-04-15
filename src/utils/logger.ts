import chalk from 'chalk'
import ora, { type Ora } from 'ora'

export const logger = {
  info:    (msg: string) => console.log(chalk.blue('  ›'), msg),
  success: (msg: string) => console.log(chalk.green('  ✓'), msg),
  warn:    (msg: string) => console.log(chalk.yellow('  ⚠'), msg),
  error:   (msg: string) => console.log(chalk.red('  ✗'), msg),
  dim:     (msg: string) => console.log(chalk.dim('    ' + msg)),
  section: (msg: string) => console.log('\n' + chalk.bold(msg)),
  spin:    (msg: string): Ora => ora(msg).start(),
}
