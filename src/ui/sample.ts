export const SAMPLE_TITLE = 'How this reader paces itself';

export const SAMPLE_TEXT = `Most speed-reading tools show every word for the same length of time. That is simple to build, but it is not how people read. When you read a page normally, your eyes rest briefly on words you expected and linger on the ones you did not.

Psycholinguists measure that expectation with a quantity called surprisal: the negative logarithm of a word's probability given everything before it. A word the context makes almost certain carries very little surprisal. A word that comes out of nowhere, like "trombone" at the end of this sentence, carries a lot.

Decades of eye-tracking experiments point to a simple rule. The time a reader spends on a word grows in a straight line with its surprisal. Double the surprisal and you add a fixed amount of reading time, whether the word was fairly likely or wildly improbable to begin with.

This reader applies that rule. A small language model runs in your browser and scores each word. Predictable words flash by; unexpected ones stay on screen a little longer. Curiously, small models predict human reading times better than large ones do, so the lightweight model here is the right tool, not a compromise.

Press Space to start and stop. While paused, the surrounding paragraph appears with your place marked, and you can click any word to jump straight to it.`;
