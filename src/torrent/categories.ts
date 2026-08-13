export interface CategoryNode {
  id: number;
  name: string;
  aliases?: string[];
  children?: CategoryNode[];
}

export const TORZNAB_CATEGORIES: CategoryNode[] = [
  {
    id: 2000,
    name: 'Movies',
    aliases: ['movie', 'films'],
    children: [
      { id: 2010, name: 'Movies/Foreign' },
      { id: 2020, name: 'Movies/Other' },
      { id: 2030, name: 'Movies/SD' },
      { id: 2040, name: 'Movies/HD' },
      { id: 2045, name: 'Movies/UHD' },
      { id: 2050, name: 'Movies/BluRay' }
    ]
  },
  {
    id: 5000,
    name: 'TV',
    aliases: ['shows', 'television'],
    children: [
      { id: 5030, name: 'TV/SD' },
      { id: 5040, name: 'TV/HD' },
      { id: 5045, name: 'TV/UHD' },
      { id: 5070, name: 'TV/Anime', aliases: ['anime'] }
    ]
  },
  {
    id: 3000,
    name: 'Audio',
    aliases: ['music', 'audiobooks', 'audiobook'],
    children: [
      { id: 3030, name: 'Audio/MP3' },
      { id: 3040, name: 'Audio/FLAC' },
      { id: 3035, name: 'Audio/Audiobook', aliases: ['audiobook', 'audiobooks'] }
    ]
  },
  {
    id: 7000,
    name: 'Books',
    aliases: ['book', 'ebooks', 'ebook', 'technical ebooks'],
    children: [
      { id: 7020, name: 'Books/EBook', aliases: ['ebook', 'ebooks'] },
      { id: 7030, name: 'Books/Comics' },
      { id: 7040, name: 'Books/Magazines' },
      { id: 7050, name: 'Books/Technical', aliases: ['technical', 'technical ebooks'] }
    ]
  }
];

export function lookupCategory(query: string) {
  const normalized = normalize(query);
  const allNodes = flatten(TORZNAB_CATEGORIES);
  const exactMatches = allNodes.filter((node) => values(node).some((value) => normalize(value) === normalized));
  const fuzzyMatches = allNodes.filter((node) =>
    !exactMatches.includes(node) && values(node).some((value) => normalize(value).includes(normalized))
  );
  return { query, exact_matches: exactMatches, fuzzy_matches: fuzzyMatches, category_tree: TORZNAB_CATEGORIES };
}

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((node) => [node, ...(node.children ? flatten(node.children) : [])]);
}

function values(node: CategoryNode): string[] {
  return [node.name, ...(node.aliases ?? [])];
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
