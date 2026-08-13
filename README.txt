GESTÃO DE BARBEARIA — SUPABASE AUTH

Esta versão usa Supabase Authentication para login por e-mail e senha.

Contas configuradas no projeto:
- Desenvolvedor: nexa@gmail.com
- Administrador: halison@gmail.com

Os dados de clientes, combos, funcionários, atendimentos, comissões e pagamentos ficam no Supabase e são compartilhados entre computador e celular.

IMPORTANTE:
1. Execute o SQL de policies authenticated fornecido junto desta versão antes de fechar/remover as policies anon.
2. Nunca coloque service_role/secret key dentro do app.
3. A Publishable Key pode permanecer no cliente; a segurança real depende de RLS e Auth.
4. Alteração de senha de outra conta deve ser feita no painel Supabase Authentication ou por backend seguro.
