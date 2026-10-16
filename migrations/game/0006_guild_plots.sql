-- One guild per city plot. Null plot_id stays free for every other guild.
-- 0005 is guild chat, so this file is 0006.

create unique index if not exists guilds_plot_id on guilds (plot_id) where plot_id is not null;
